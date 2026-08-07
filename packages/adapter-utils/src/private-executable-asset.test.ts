import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrivateExecutableAssetDirectory } from "./private-executable-asset.js";

const execFileAsync = promisify(execFile);
const cleanupPaths = new Set<string>();
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
  currentUserSid: string;
  ownerSid: string;
  protected: boolean;
  rules: WindowsAccessRule[];
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("SystemRoot is required for the Windows private-asset integration test.");
  }
  return path.win32.join(
    path.win32.resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function runWindowsPowerShell(
  script: string,
  env: Record<string, string>,
): Promise<string> {
  const { stdout } = await execFileAsync(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  return stdout;
}

async function readWindowsAcl(targetPath: string): Promise<WindowsAclSnapshot> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$acl = [System.IO.Directory]::GetAccessControl($env:PAPERCLIP_PRIVATE_ASSET_TEST_TARGET)",
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
    "  currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "  ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "  protected = $acl.AreAccessRulesProtected",
    "  rules = $rules",
    "} | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");
  const output = await runWindowsPowerShell(script, {
    PAPERCLIP_PRIVATE_ASSET_TEST_TARGET: targetPath,
  });
  return JSON.parse(output) as WindowsAclSnapshot;
}

async function addWindowsParentRule(input: {
  parentPath: string;
  sid: string;
  rights: "DeleteSubdirectoriesAndFiles" | "ReadAttributes";
}): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:PAPERCLIP_PRIVATE_ASSET_TEST_TARGET",
    "$sid = [System.Security.Principal.SecurityIdentifier]::new($env:PAPERCLIP_PRIVATE_ASSET_TEST_SID)",
    "$rights = [System.Security.AccessControl.FileSystemRights]::$($env:PAPERCLIP_PRIVATE_ASSET_TEST_RIGHTS)",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow)",
    "$acl = [System.IO.Directory]::GetAccessControl($target)",
    "[void]$acl.AddAccessRule($rule)",
    "[System.IO.Directory]::SetAccessControl($target, $acl)",
  ].join("\n");
  await runWindowsPowerShell(script, {
    PAPERCLIP_PRIVATE_ASSET_TEST_TARGET: input.parentPath,
    PAPERCLIP_PRIVATE_ASSET_TEST_SID: input.sid,
    PAPERCLIP_PRIVATE_ASSET_TEST_RIGHTS: input.rights,
  });
}

async function createTestParent(prefix: string): Promise<string> {
  if (process.platform === "win32") {
    const parentAsset = await createPrivateExecutableAssetDirectory({ prefix });
    cleanupPaths.add(parentAsset.directoryPath);
    return parentAsset.directoryPath;
  }
  const parentPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.add(parentPath);
  return parentPath;
}

afterEach(async () => {
  for (const cleanupPath of cleanupPaths) {
    await fs.rm(cleanupPath, { recursive: true, force: true }).catch(() => undefined);
    cleanupPaths.delete(cleanupPath);
  }
});

describe("createPrivateExecutableAssetDirectory", () => {
  it("creates a private directory, revalidates it after population, and cleans it idempotently", async () => {
    const asset = await createPrivateExecutableAssetDirectory({
      prefix: "paperclip-private-asset-test-",
    });
    cleanupPaths.add(asset.directoryPath);
    const executablePath = path.join(asset.directoryPath, "asset.mjs");

    await fs.writeFile(executablePath, "console.log('test-only');\n", {
      encoding: "utf8",
      mode: 0o700,
    });
    await asset.assertIntegrity();

    const stat = await fs.lstat(asset.directoryPath);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    if (process.platform === "win32") {
      const acl = await readWindowsAcl(asset.directoryPath);
      const allowedSids = new Set([
        acl.currentUserSid.toUpperCase(),
        LOCAL_SYSTEM_SID,
        BUILTIN_ADMINISTRATORS_SID,
      ]);
      expect(acl.ownerSid.toUpperCase()).toBe(acl.currentUserSid.toUpperCase());
      expect(acl.protected).toBe(true);
      expect(acl.rules).toHaveLength(allowedSids.size);
      expect(new Set(acl.rules.map((rule) => rule.sid.toUpperCase()))).toEqual(allowedSids);
      for (const rule of acl.rules) {
        expect(rule).toMatchObject({
          inherited: false,
          rights: FULL_CONTROL,
          inheritanceFlags: CONTAINER_AND_OBJECT_INHERIT,
          propagationFlags: 0,
          type: 0,
        });
      }
    } else {
      expect(stat.mode & 0o777).toBe(0o700);
      if (typeof process.getuid === "function") expect(stat.uid).toBe(process.getuid());
    }

    await asset.cleanup();
    cleanupPaths.delete(asset.directoryPath);
    await expect(fs.lstat(asset.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(asset.cleanup()).resolves.toBeUndefined();
  }, 20_000);

  it("retries cleanup after a transient recursive-remove failure", async () => {
    const asset = await createPrivateExecutableAssetDirectory({
      prefix: "paperclip-private-asset-retry-",
    });
    cleanupPaths.add(asset.directoryPath);
    const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(
      Object.assign(new Error("test-only transient remove failure"), { code: "EBUSY" }),
    );
    try {
      await expect(asset.cleanup()).rejects.toThrow(/transient remove failure/i);
    } finally {
      remove.mockRestore();
    }

    await expect(asset.cleanup()).resolves.toBeUndefined();
    cleanupPaths.delete(asset.directoryPath);
    await expect(fs.lstat(asset.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("fails closed without deleting a replacement directory", async () => {
    const asset = await createPrivateExecutableAssetDirectory({
      prefix: "paperclip-private-asset-swap-",
    });
    const originalPath = `${asset.directoryPath}.original`;
    cleanupPaths.add(asset.directoryPath);
    cleanupPaths.add(originalPath);
    await fs.rename(asset.directoryPath, originalPath);
    await fs.mkdir(asset.directoryPath);
    await fs.writeFile(path.join(asset.directoryPath, "do-not-delete.txt"), "replacement", "utf8");

    await expect(asset.assertIntegrity()).rejects.toThrow(/identity changed/i);
    await expect(asset.cleanup()).rejects.toThrow(/identity changed/i);
    await expect(
      fs.readFile(path.join(asset.directoryPath, "do-not-delete.txt"), "utf8"),
    ).resolves.toBe("replacement");
  }, 20_000);

  it("fails closed when the parent path is replaced", async () => {
    const parentPath = await createTestParent("paperclip-private-parent-");
    const movedParentPath = `${parentPath}.original`;
    cleanupPaths.add(parentPath);
    cleanupPaths.add(movedParentPath);
    const asset = await createPrivateExecutableAssetDirectory({
      prefix: "asset-",
      parentDirectory: parentPath,
    });

    await fs.rename(parentPath, movedParentPath);
    await fs.mkdir(parentPath);

    await expect(asset.assertIntegrity()).rejects.toThrow(/parent identity changed/i);
    await expect(asset.cleanup()).rejects.toThrow(/parent identity changed/i);
    await expect(fs.lstat(path.join(movedParentPath, path.basename(asset.directoryPath)))).resolves
      .toMatchObject({ isDirectory: expect.any(Function) });
  }, 20_000);

  it.runIf(process.platform !== "win32")(
    "rejects a non-sticky group/world-writable POSIX parent",
    async () => {
      const parentPath = await createTestParent("paperclip-private-posix-parent-");
      await fs.chmod(parentPath, 0o777);

      await expect(createPrivateExecutableAssetDirectory({
        prefix: "asset-",
        parentDirectory: parentPath,
      })).rejects.toThrow(/unsafe group\/world mutation authority/i);
      expect(await fs.readdir(parentPath)).toEqual([]);
    },
    20_000,
  );

  it.runIf(process.platform !== "win32")(
    "detects POSIX parent mutation-authority changes after creation",
    async () => {
      const parentPath = await createTestParent("paperclip-private-posix-policy-");
      const asset = await createPrivateExecutableAssetDirectory({
        prefix: "asset-",
        parentDirectory: parentPath,
      });
      await fs.chmod(parentPath, 0o777);

      await expect(asset.assertIntegrity()).rejects.toThrow(/mutation authority/i);
      await expect(asset.cleanup()).rejects.toThrow(/mutation authority/i);
      await expect(fs.lstat(asset.directoryPath)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });

      await fs.chmod(parentPath, 0o700);
      await asset.cleanup();
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "rejects a parent that grants mapped or unknown untrusted DELETE_CHILD authority",
    async () => {
      for (const sid of [BUILTIN_USERS_SID, UNMAPPED_TEST_SID]) {
        const parentPath = await createTestParent("paperclip-private-delete-child-");
        await addWindowsParentRule({
          parentPath,
          sid,
          rights: "DeleteSubdirectoriesAndFiles",
        });

        await expect(createPrivateExecutableAssetDirectory({
          prefix: "asset-",
          parentDirectory: parentPath,
        })).rejects.toThrow(/DeleteSubdirectoriesAndFiles.*untrusted SID/i);
        expect((await fs.readdir(parentPath)).filter((entry) => entry.startsWith("asset-"))).toEqual([]);
      }
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "detects parent access-policy tamper after atomic creation",
    async () => {
      const parentPath = await createTestParent("paperclip-private-parent-acl-");
      const asset = await createPrivateExecutableAssetDirectory({
        prefix: "asset-",
        parentDirectory: parentPath,
      });
      await addWindowsParentRule({
        parentPath,
        sid: BUILTIN_USERS_SID,
        rights: "ReadAttributes",
      });

      await expect(asset.assertIntegrity()).rejects.toThrow(/parent access policy changed/i);
      await expect(asset.cleanup()).rejects.toThrow(/parent access policy changed/i);
      await expect(fs.lstat(asset.directoryPath)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    },
    20_000,
  );
});
