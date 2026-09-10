import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPrivateStagingDirectory,
  createPrivateStagingDirectory,
  hardenNewFileInsidePrivateStagingDirectory,
  prepareCodexCredentialInstallAcl,
  verifyCodexCredentialInstallAcl,
  verifyPrivateStagingDirectory,
} from "./windows-private-acl.js";

const execFileAsync = promisify(execFile);
const testRoots = new Set<string>();
const LOCAL_SYSTEM_SID = "S-1-5-18";
const BUILTIN_ADMINISTRATORS_SID = "S-1-5-32-544";
const BUILTIN_USERS_SID = "S-1-5-32-545";
const UNMAPPED_TEST_SID = "S-1-5-21-1111111111-2222222222-3333333333-4444";
const FULL_CONTROL = 2_032_127;
const CONTAINER_AND_OBJECT_INHERIT = 3;

interface WindowsAccessRule {
  sid: string;
  inherited: boolean;
  rights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  type: number;
}

interface WindowsAclSnapshot {
  protected: boolean;
  currentUserSid: string;
  rules: WindowsAccessRule[];
}

function windowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot is required for the Windows ACL integration test.");
  }
  return path.win32.join(
    path.win32.resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function readWindowsAcl(targetPath: string): Promise<WindowsAclSnapshot> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:PAPERCLIP_ACL_TEST_TARGET",
    "$acl = if ([System.IO.Directory]::Exists($target)) {",
    "  [System.IO.Directory]::GetAccessControl($target)",
    "} else {",
    "  [System.IO.File]::GetAccessControl($target)",
    "}",
    "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {",
    "  [pscustomobject]@{",
    "    sid = $_.IdentityReference.Value",
    "    inherited = $_.IsInherited",
    "    rights = [int]$_.FileSystemRights",
    "    inheritanceFlags = [int]$_.InheritanceFlags",
    "    propagationFlags = [int]$_.PropagationFlags",
    "    type = [int]$_.AccessControlType",
    "  }",
    "})",
    "[pscustomobject]@{",
    "  protected = $acl.AreAccessRulesProtected",
    "  currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "  rules = $rules",
    "} | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");

  const { stdout } = await execFileAsync(
    windowsPowerShell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: { ...process.env, PAPERCLIP_ACL_TEST_TARGET: targetPath },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as WindowsAclSnapshot;
}

async function addWindowsParentRule(input: {
  parentPath: string;
  sid: string;
  rights: "DeleteSubdirectoriesAndFiles" | "ReadAttributes";
}): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:PAPERCLIP_ACL_TEST_TARGET",
    "$sid = [System.Security.Principal.SecurityIdentifier]::new($env:PAPERCLIP_ACL_TEST_SID)",
    "$rights = [System.Security.AccessControl.FileSystemRights]::$($env:PAPERCLIP_ACL_TEST_RIGHTS)",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow)",
    "$acl = [System.IO.Directory]::GetAccessControl($target)",
    "[void]$acl.AddAccessRule($rule)",
    "[System.IO.Directory]::SetAccessControl($target, $acl)",
  ].join("\n");
  await execFileAsync(
    windowsPowerShell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PAPERCLIP_ACL_TEST_TARGET: input.parentPath,
        PAPERCLIP_ACL_TEST_SID: input.sid,
        PAPERCLIP_ACL_TEST_RIGHTS: input.rights,
      },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

async function resolveCodexSandboxUsersSidForTest(): Promise<string | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $name = [System.Security.Principal.NTAccount]::new([Environment]::MachineName, 'CodexSandboxUsers')",
    "  $name.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "} catch {",
    "  $cause = $_.Exception",
    "  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }",
    "  if ($cause -is [System.Security.Principal.IdentityNotMappedException]) { '' } else { throw }",
    "}",
  ].join("\n");
  const { stdout } = await execFileAsync(
    windowsPowerShell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  const sid = stdout.trim();
  return sid ? sid.toUpperCase() : null;
}

async function canReadAsRestrictedSid(targetPath: string, sid: string): Promise<boolean> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.IO;",
    "using System.ComponentModel;",
    "using System.Runtime.InteropServices;",
    "using System.Security.Principal;",
    "public static class PaperclipRestrictedTokenReadProbe {",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }",
    "  [DllImport(\"kernel32.dll\")] private static extern IntPtr GetCurrentProcess();",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);",
    "  [DllImport(\"advapi32.dll\", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);",
    "  [DllImport(\"advapi32.dll\", SetLastError = true)] private static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes, int impersonationLevel, int tokenType, out IntPtr token);",
    "  [DllImport(\"advapi32.dll\", SetLastError = true)]",
    "  private static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr disabled, uint privilegeCount, IntPtr privileges, uint restrictedCount, [In] SidAndAttributes[] restricted, out IntPtr token);",
    "  [DllImport(\"advapi32.dll\", SetLastError = true)] private static extern bool SetThreadToken(IntPtr thread, IntPtr token);",
    "  [DllImport(\"advapi32.dll\", SetLastError = true)] private static extern bool RevertToSelf();",
    "  public static bool CanRead(string path, string sidValue) {",
    "    IntPtr source = IntPtr.Zero, duplicate = IntPtr.Zero, restrictedToken = IntPtr.Zero, sidMemory = IntPtr.Zero;",
    "    try {",
    "      const uint TOKEN_DUPLICATE = 0x0002, TOKEN_IMPERSONATE = 0x0004, TOKEN_QUERY = 0x0008;",
    "      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, out source)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      if (!DuplicateTokenEx(source, TOKEN_DUPLICATE | TOKEN_IMPERSONATE | TOKEN_QUERY, IntPtr.Zero, 2, 2, out duplicate)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      SecurityIdentifier sid = new SecurityIdentifier(sidValue);",
    "      byte[] bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);",
    "      sidMemory = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, sidMemory, bytes.Length);",
    "      SidAndAttributes[] restriction = new SidAndAttributes[] { new SidAndAttributes { Sid = sidMemory, Attributes = 0 } };",
    // DISABLE_MAX_PRIVILEGE still preserves SeChangeNotifyPrivilege, matching
    // the sandbox bypass-traverse condition that made parent enumeration
    // relevant to this regression.
    "      if (!CreateRestrictedToken(duplicate, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, restriction, out restrictedToken)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      if (!SetThreadToken(IntPtr.Zero, restrictedToken)) throw new Win32Exception(Marshal.GetLastWin32Error());",
    "      try {",
    "        try { using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) { return stream.ReadByte() >= -1; } }",
    "        catch (UnauthorizedAccessException) { return false; }",
    "      } finally { if (!RevertToSelf()) throw new Win32Exception(Marshal.GetLastWin32Error()); }",
    "    } finally {",
    "      if (sidMemory != IntPtr.Zero) Marshal.FreeHGlobal(sidMemory);",
    "      if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);",
    "      if (duplicate != IntPtr.Zero) CloseHandle(duplicate);",
    "      if (source != IntPtr.Zero) CloseHandle(source);",
    "    }",
    "  }",
    "}",
    "'@",
    "[PaperclipRestrictedTokenReadProbe]::CanRead($env:PAPERCLIP_ACL_TEST_TARGET, $env:PAPERCLIP_ACL_TEST_SID)",
  ].join("\n");
  const { stdout } = await execFileAsync(
    windowsPowerShell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PAPERCLIP_ACL_TEST_TARGET: targetPath,
        PAPERCLIP_ACL_TEST_SID: sid,
      },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  const result = stdout.trim().toLowerCase();
  if (result !== "true" && result !== "false") {
    throw new Error(`Restricted-token read probe returned unexpected output: ${stdout}`);
  }
  return result === "true";
}

afterEach(async () => {
  for (const root of testRoots) {
    await fs.rm(root, { recursive: true, force: true });
    testRoots.delete(root);
  }
});

describe("private Codex staging custody", () => {
  it("creates a private staging root before it becomes visible to inherited readers", async () => {
    const target = await createPrivateStagingDirectory(
      null,
      "paperclip-atomic-private-stage-",
    );
    testRoots.add(target);

    expect(await fs.readdir(target)).toEqual([]);
    if (process.platform === "win32") {
      const directoryAcl = await readWindowsAcl(target);
      const allowedSids = new Set([
        directoryAcl.currentUserSid.toUpperCase(),
        LOCAL_SYSTEM_SID,
        BUILTIN_ADMINISTRATORS_SID,
      ]);
      expect(directoryAcl.protected).toBe(true);
      expect(directoryAcl.rules).toHaveLength(allowedSids.size);
      expect(directoryAcl.rules.every((rule) => !rule.inherited)).toBe(true);
      expect(new Set(directoryAcl.rules.map((rule) => rule.sid.toUpperCase()))).toEqual(allowedSids);
    } else {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    }
  });

  it("accepts the longest existing ACP staged-home prefix while keeping a bounded path segment", async () => {
    const prefix = `paperclip-codex-home-sync-run-keep-staged-home-${process.pid}-${randomUUID()}-`;
    const target = await createPrivateStagingDirectory(null, prefix);
    testRoots.add(target);

    expect(path.basename(target).startsWith(prefix)).toBe(true);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("revalidates the exact parent and staging root after secret population", async () => {
    const target = await createPrivateStagingDirectory(
      null,
      "paperclip-codex-populated-proof-",
    );
    testRoots.add(target);
    await fs.writeFile(path.join(target, "auth.json"), "{\"token\":\"test-only\"}", "utf8");

    await expect(verifyPrivateStagingDirectory(target)).resolves.toBeUndefined();

    const original = `${target}.original`;
    testRoots.add(original);
    await fs.rename(target, original);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "do-not-consume.json"), "replacement", "utf8");

    await expect(verifyPrivateStagingDirectory(target)).rejects.toThrow(/identity changed/i);
    await expect(fs.readFile(path.join(target, "do-not-consume.json"), "utf8"))
      .resolves.toBe("replacement");
  }, 20_000);

  it("cleans an exact proved staging directory and rejects an unknown repeat", async () => {
    const target = await createPrivateStagingDirectory(
      null,
      "paperclip-codex-cleanup-proof-",
    );
    testRoots.add(target);
    await fs.writeFile(path.join(target, "auth.json"), "{\"token\":\"test-only\"}", "utf8");

    await expect(cleanupPrivateStagingDirectory(target)).resolves.toBeUndefined();
    await expect(cleanupPrivateStagingDirectory(target)).rejects.toThrow(
      /no process-local custody proof/i,
    );
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it.runIf(process.platform === "win32")(
    "rejects mapped and unmapped untrusted parent DELETE_CHILD authority",
    async () => {
      for (const sid of [BUILTIN_USERS_SID, UNMAPPED_TEST_SID]) {
        const parent = await createPrivateStagingDirectory(
          null,
          "paperclip-codex-parent-proof-",
        );
        testRoots.add(parent);
        await addWindowsParentRule({
          parentPath: parent,
          sid,
          rights: "DeleteSubdirectoriesAndFiles",
        });

        await expect(createPrivateStagingDirectory(parent, "child-"))
          .rejects.toThrow(/DeleteSubdirectoriesAndFiles.*untrusted SID/i);
        expect((await fs.readdir(parent)).filter((entry) => entry.startsWith("child-")))
          .toEqual([]);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")("sets the final POSIX credential mode after bytes exist", async () => {
    const target = await createPrivateStagingDirectory(
      null,
      "paperclip-posix-final-credential-",
    );
    testRoots.add(target);
    const filePath = path.join(target, "auth.json.tmp");
    await fs.writeFile(filePath, "test-only", { mode: 0o644 });

    const proof = await prepareCodexCredentialInstallAcl(target, filePath);
    await verifyCodexCredentialInstallAcl(filePath, proof);

    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("rejects hardening a file whose parent has no process-local custody proof", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-unproved-private-file-"));
    testRoots.add(root);
    const stagedPath = path.join(root, "auth.json");
    await fs.writeFile(stagedPath, "", "utf8");

    await expect(hardenNewFileInsidePrivateStagingDirectory(root, stagedPath))
      .rejects.toThrow(/no process-local custody proof/i);
  });

  it.runIf(process.platform === "win32")(
    "keeps copy-back bytes private before install and preserves the exact final DACL through rename",
    async () => {
      const target = await createPrivateStagingDirectory(
        null,
        "paperclip-copyback-private-file-",
      );
      testRoots.add(target);
      const stagedPath = path.join(target, "auth.json.private-stage");
      const finalPath = path.join(target, "auth.json");
      await fs.writeFile(stagedPath, "", "utf8");

      await hardenNewFileInsidePrivateStagingDirectory(target, stagedPath);
      const privateAcl = await readWindowsAcl(stagedPath);
      const baseSids = new Set([
        privateAcl.currentUserSid.toUpperCase(),
        LOCAL_SYSTEM_SID,
        BUILTIN_ADMINISTRATORS_SID,
      ]);
      expect(privateAcl.protected).toBe(true);
      expect(privateAcl.rules).toHaveLength(baseSids.size);
      expect(new Set(privateAcl.rules.map((rule) => rule.sid.toUpperCase()))).toEqual(baseSids);
      expect(privateAcl.rules.every((rule) => (
        !rule.inherited
        && rule.type === 0
        && rule.rights === FULL_CONTROL
        && rule.inheritanceFlags === 0
      ))).toBe(true);

      await fs.writeFile(stagedPath, "{\"token\":\"test-only\"}", "utf8");
      const expectedSandboxSid = await resolveCodexSandboxUsersSidForTest();
      if (expectedSandboxSid) {
        // This token keeps the current user as its normal grant set but adds
        // CodexSandboxUsers as a restricting SID. Windows therefore requires
        // both the owner grant and the sandbox-group grant. The private stage
        // must be unreadable until the accepted install policy is applied.
        await expect(canReadAsRestrictedSid(stagedPath, expectedSandboxSid)).resolves.toBe(false);
      }

      const finalProof = await prepareCodexCredentialInstallAcl(target, stagedPath);
      await verifyCodexCredentialInstallAcl(stagedPath, finalProof);
      if (expectedSandboxSid) {
        await expect(canReadAsRestrictedSid(stagedPath, expectedSandboxSid)).resolves.toBe(true);
      }
      await fs.rename(stagedPath, finalPath);

      const finalAcl = await readWindowsAcl(finalPath);
      expect(finalAcl.protected).toBe(true);
      expect(finalAcl.rules.every((rule) => !rule.inherited && rule.type === 0)).toBe(true);
      const finalSids = new Set(finalAcl.rules.map((rule) => rule.sid.toUpperCase()));
      for (const sid of baseSids) expect(finalSids.has(sid)).toBe(true);
      expect(finalAcl.rules.filter((rule) => baseSids.has(rule.sid.toUpperCase())).every((rule) => (
        rule.rights === FULL_CONTROL && rule.inheritanceFlags === 0
      ))).toBe(true);
      const sandboxRules = finalAcl.rules.filter((rule) => !baseSids.has(rule.sid.toUpperCase()));
      expect(sandboxRules).toHaveLength(expectedSandboxSid ? 1 : 0);
      if (expectedSandboxSid) {
        expect(sandboxRules[0]!.sid.toUpperCase()).toBe(expectedSandboxSid);
      }
      expect(sandboxRules.every((rule) => (
        rule.rights === 1_179_817
        && rule.inheritanceFlags === 0
        && rule.propagationFlags === 0
      ))).toBe(true);
      await expect(fs.readFile(finalPath, "utf8")).resolves.toContain("test-only");
    },
  );
});
