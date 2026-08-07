import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  createPrivateExecutableAssetDirectory,
  type PrivateExecutableAssetDirectory,
} from "@paperclipai/adapter-utils/private-executable-asset";

const execFileAsync = promisify(execFile);

const LOCAL_SYSTEM_SID = "S-1-5-18";
const BUILTIN_ADMINISTRATORS_SID = "S-1-5-32-544";
const WINDOWS_COMMAND_TIMEOUT_MS = 10_000;
const WINDOWS_COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
const SID_PATTERN = /\bS-\d+(?:-\d+)+\b/gi;
const FULL_CONTROL = 2_032_127;
const READ_AND_EXECUTE_WITH_SYNCHRONIZE = 1_179_817;
const privateStagingProofs = new Map<string, PrivateExecutableAssetDirectory>();

interface PathIdentity {
  dev: number;
  ino: number;
  realPath: string;
}

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

function system32Executable(name: "icacls.exe" | "whoami.exe"): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Cannot secure private staging directory: SystemRoot is unavailable or not absolute.");
  }
  return path.win32.join(path.win32.resolve(systemRoot), "System32", name);
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Cannot verify private access policy: SystemRoot is unavailable or not absolute.");
  }
  return path.win32.join(
    path.win32.resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function runWindowsCommand(
  executable: "icacls.exe" | "whoami.exe",
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(system32Executable(executable), [...args], {
    encoding: "utf8",
    maxBuffer: WINDOWS_COMMAND_MAX_BUFFER_BYTES,
    shell: false,
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

async function runWindowsPowerShell(script: string, env: Record<string, string>): Promise<string> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    throw new Error("Cannot verify private access policy: SystemRoot is unavailable.");
  }
  const { stdout } = await execFileAsync(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, ...env },
      maxBuffer: WINDOWS_COMMAND_MAX_BUFFER_BYTES,
      shell: false,
      timeout: WINDOWS_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  return stdout;
}

async function readWindowsAcl(targetPath: string): Promise<WindowsAclSnapshot> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:PAPERCLIP_PRIVATE_ACL_TARGET",
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
  const output = await runWindowsPowerShell(script, {
    PAPERCLIP_PRIVATE_ACL_TARGET: targetPath,
  });
  return JSON.parse(output) as WindowsAclSnapshot;
}

async function currentWindowsUserSid(): Promise<string> {
  // Microsoft documents `/user /fo csv /nh` as a headerless result containing
  // the current token's user SID. Extract exactly one SID rather than depending
  // on a localized account name or column label.
  const output = await runWindowsCommand("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const matches = output.match(SID_PATTERN) ?? [];
  if (matches.length !== 1) {
    throw new Error("Cannot secure private staging directory: whoami returned no unique current-user SID.");
  }
  return matches[0]!.toUpperCase();
}

async function pathIdentity(targetPath: string): Promise<PathIdentity> {
  const stat = await fs.lstat(targetPath);
  return {
    dev: stat.dev,
    ino: stat.ino,
    realPath: await fs.realpath(targetPath),
  };
}

function samePathIdentity(before: PathIdentity, after: PathIdentity): boolean {
  const sameRealPath = process.platform === "win32"
    ? before.realPath.toLowerCase() === after.realPath.toLowerCase()
    : before.realPath === after.realPath;
  return before.dev === after.dev && before.ino === after.ino && sameRealPath;
}

function privateStagingProofKey(directoryPath: string): string {
  const resolved = path.resolve(directoryPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Creates a randomized empty staging directory with launch-time private
 * custody. The shared primitive applies the Windows DACL atomically, rejects
 * every untrusted parent DELETE_CHILD principal (including unmapped SIDs), and
 * retains parent/child identity proof for later secret-population readback.
 */
export async function createPrivateStagingDirectory(
  parentPath: string | null,
  prefix: string,
): Promise<string> {
  const proof = await createPrivateExecutableAssetDirectory({
    prefix,
    ...(parentPath ? { parentDirectory: parentPath } : {}),
  });
  const proofKey = privateStagingProofKey(proof.directoryPath);
  if (privateStagingProofs.has(proofKey)) {
    await proof.cleanup();
    throw new Error("Private staging proof identity unexpectedly collided.");
  }
  privateStagingProofs.set(proofKey, proof);
  return proof.directoryPath;
}

/** Revalidates parent identity/policy and exact staging-root identity/policy. */
export async function verifyPrivateStagingDirectory(directoryPath: string): Promise<void> {
  const proof = privateStagingProofs.get(privateStagingProofKey(directoryPath));
  if (!proof) {
    throw new Error("Private staging directory has no process-local custody proof.");
  }
  await proof.assertIntegrity();
}

/** Safely removes the exact proved staging directory; retryable after failure. */
export async function cleanupPrivateStagingDirectory(directoryPath: string): Promise<void> {
  const proofKey = privateStagingProofKey(directoryPath);
  const proof = privateStagingProofs.get(proofKey);
  if (!proof) {
    throw new Error("Private staging directory has no process-local custody proof.");
  }
  await proof.cleanup();
  privateStagingProofs.delete(proofKey);
}

/** Drops proof only after a caller has independently proved exact cleanup. */
export function forgetPrivateStagingDirectoryProof(directoryPath: string): void {
  privateStagingProofs.delete(privateStagingProofKey(directoryPath));
}

async function assertRegularFile(filePath: string, requireEmpty: boolean): Promise<PathIdentity> {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Private staging file must use an absolute path.");
  }
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Private staging path must be a regular file, not a symlink.");
  }
  if (requireEmpty && stat.size !== 0) {
    throw new Error("Private staging file must be empty before its access policy is replaced.");
  }
  return pathIdentity(filePath);
}

function assertExactWindowsAcl(
  snapshot: WindowsAclSnapshot,
  expected: Map<string, { rights: number; inheritanceFlags: number }>,
): void {
  if (!snapshot.protected || snapshot.rules.length !== expected.size) {
    throw new Error("Private access-policy verification failed: DACL is not protected and exact.");
  }
  for (const rule of snapshot.rules) {
    const wanted = expected.get(rule.sid.toUpperCase());
    if (
      !wanted
      || rule.inherited
      || rule.type !== 0
      || rule.rights !== wanted.rights
      || rule.inheritanceFlags !== wanted.inheritanceFlags
      || rule.propagationFlags !== 0
    ) {
      throw new Error("Private access-policy verification failed: unexpected access rule.");
    }
  }
}

async function resolveCodexSandboxUsersSid(): Promise<string | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $name = [System.Security.Principal.NTAccount]::new([Environment]::MachineName, 'CodexSandboxUsers')",
    "  $name.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "} catch {",
    "  $cause = $_.Exception",
    "  while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }",
    "  if ($cause -is [System.Security.Principal.IdentityNotMappedException]) {",
    // A genuinely absent local group is optional. PowerShell can wrap .NET
    // method exceptions, so unwrap to the root type; every other lookup, LSA,
    // or permission failure propagates instead of silently omitting the reader.
    "    ''",
    "  } else {",
    "    throw",
    "  }",
    "}",
  ].join("\n");
  const output = (await runWindowsPowerShell(script, {})).trim();
  if (!output) return null;
  if (!new RegExp(`^${SID_PATTERN.source}$`, "i").test(output)) {
    throw new Error("Cannot secure Codex credential: CodexSandboxUsers resolved to an invalid SID.");
  }
  return output.toUpperCase();
}

async function replaceWindowsFileDacl(
  filePath: string,
  identity: PathIdentity,
  readOnlySids: readonly string[] = [],
): Promise<void> {
  const currentUserSid = await currentWindowsUserSid();
  const fullControlSids = [...new Set([
    currentUserSid,
    LOCAL_SYSTEM_SID,
    BUILTIN_ADMINISTRATORS_SID,
  ])];
  const readSids = [...new Set(readOnlySids.map((sid) => sid.toUpperCase()))]
    .filter((sid) => !fullControlSids.includes(sid));

  const dacl = [
    "D:P",
    ...fullControlSids.map((sid) => `(A;;FA;;;${sid})`),
    ...readSids.map((sid) => `(A;;0x${READ_AND_EXECUTE_WITH_SYNCHRONIZE.toString(16)};;;${sid})`),
  ].join("");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:PAPERCLIP_PRIVATE_FILE_TARGET",
    "$security = [System.Security.AccessControl.FileSecurity]::new()",
    "$security.SetSecurityDescriptorSddlForm($env:PAPERCLIP_PRIVATE_FILE_DACL, [System.Security.AccessControl.AccessControlSections]::Access)",
    // File.SetAccessControl submits the complete protected DACL in one OS
    // operation. A secret-bearing accepted credential therefore never passes
    // through `/reset` or an inherited-reader intermediate state.
    "[System.IO.File]::SetAccessControl($target, $security)",
  ].join("\n");
  await runWindowsPowerShell(script, {
    PAPERCLIP_PRIVATE_FILE_TARGET: filePath,
    PAPERCLIP_PRIVATE_FILE_DACL: dacl,
  });

  const expected = new Map<string, { rights: number; inheritanceFlags: number }>();
  for (const sid of fullControlSids) {
    expected.set(sid.toUpperCase(), { rights: FULL_CONTROL, inheritanceFlags: 0 });
  }
  for (const sid of readSids) {
    expected.set(sid, { rights: READ_AND_EXECUTE_WITH_SYNCHRONIZE, inheritanceFlags: 0 });
  }
  assertExactWindowsAcl(await readWindowsAcl(filePath), expected);
  if (!samePathIdentity(identity, await pathIdentity(filePath))) {
    throw new Error("Private staging file identity changed while its access policy was replaced.");
  }
}

async function verifyWindowsFileDacl(filePath: string, readOnlySids: readonly string[]): Promise<void> {
  const currentUserSid = await currentWindowsUserSid();
  const expected = new Map<string, { rights: number; inheritanceFlags: number }>([
    [currentUserSid, { rights: FULL_CONTROL, inheritanceFlags: 0 }],
    [LOCAL_SYSTEM_SID, { rights: FULL_CONTROL, inheritanceFlags: 0 }],
    [BUILTIN_ADMINISTRATORS_SID, { rights: FULL_CONTROL, inheritanceFlags: 0 }],
  ]);
  for (const sid of readOnlySids) {
    if (!expected.has(sid.toUpperCase())) {
      expected.set(sid.toUpperCase(), {
        rights: READ_AND_EXECUTE_WITH_SYNCHRONIZE,
        inheritanceFlags: 0,
      });
    }
  }
  assertExactWindowsAcl(await readWindowsAcl(filePath), expected);
}

/**
 * Hardens a still-empty credential file that was created inside a staging root
 * with process-local custody proof. A generic visible path is deliberately
 * rejected: changing its ACL after creation cannot revoke a reader's already
 * open handle.
 */
export async function hardenNewFileInsidePrivateStagingDirectory(
  stagingDirectoryPath: string,
  filePath: string,
): Promise<void> {
  const proof = privateStagingProofs.get(privateStagingProofKey(stagingDirectoryPath));
  if (!proof) {
    throw new Error("Private staging directory has no process-local custody proof.");
  }
  const resolvedStagingDirectory = path.resolve(stagingDirectoryPath);
  if (path.dirname(path.resolve(filePath)) !== resolvedStagingDirectory) {
    throw new Error("Private staging file must be an immediate child of its proved directory.");
  }
  await proof.assertIntegrity();
  const identity = await assertRegularFile(filePath, true);
  if (process.platform === "win32") {
    await replaceWindowsFileDacl(filePath, identity);
  } else {
    await fs.chmod(filePath, 0o600);
    const mode = (await fs.stat(filePath)).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`Private staging file mode verification failed: expected 0600, got ${mode.toString(8)}.`);
    }
  }
}

/**
 * Applies the final host Codex credential policy after the merge decision and
 * immediately before atomic installation.
 * If OpenAI's local restricted-token group exists, it receives read/execute;
 * no other sandbox or inherited principal is retained. The policy is read back
 * exactly before the caller may rename the file over the shared credential.
 */
export interface CodexCredentialAclProof {
  readonly dev: number;
  readonly ino: number;
  readonly realPath: string;
  readonly readOnlySids: readonly string[];
}

export async function prepareCodexCredentialInstallAcl(
  stagingDirectoryPath: string,
  filePath: string,
): Promise<CodexCredentialAclProof> {
  const stagingProof = privateStagingProofs.get(
    privateStagingProofKey(stagingDirectoryPath),
  );
  if (!stagingProof) {
    throw new Error("Private staging directory has no process-local custody proof.");
  }
  if (path.dirname(path.resolve(filePath)) !== path.resolve(stagingDirectoryPath)) {
    throw new Error("Codex credential staging file must be an immediate child of its proved directory.");
  }
  await stagingProof.assertIntegrity();
  // The proved root kept this staged file private through its write and
  // decision. Windows installs the complete final DACL atomically, so adding
  // the standard sandbox readers cannot expose a rejected credential through
  // an inherited-ACL intermediate state.
  const identity = await assertRegularFile(filePath, false);
  if (process.platform === "win32") {
    const codexSandboxSid = await resolveCodexSandboxUsersSid();
    const readOnlySids = codexSandboxSid ? [codexSandboxSid] : [];
    await replaceWindowsFileDacl(filePath, identity, readOnlySids);
    return { ...identity, readOnlySids };
  }
  await fs.chmod(filePath, 0o600);
  const mode = (await fs.stat(filePath)).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`Codex credential mode verification failed: expected 0600, got ${mode.toString(8)}.`);
  }
  return { ...identity, readOnlySids: [] };
}

/** Read-only proof that the prepared policy and file identity still match. */
export async function verifyCodexCredentialInstallAcl(
  filePath: string,
  proof: CodexCredentialAclProof,
): Promise<void> {
  const currentIdentity = await assertRegularFile(filePath, false);
  if (!samePathIdentity(proof, currentIdentity)) {
    throw new Error("Codex credential staging identity changed after access-policy preparation.");
  }
  if (process.platform === "win32") {
    await verifyWindowsFileDacl(filePath, proof.readOnlySids);
    return;
  }
  const mode = (await fs.stat(filePath)).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`Codex credential mode verification failed: expected 0600, got ${mode.toString(8)}.`);
  }
}
