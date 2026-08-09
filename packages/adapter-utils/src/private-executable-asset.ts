import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCAL_SYSTEM_SID = "S-1-5-18";
const BUILTIN_ADMINISTRATORS_SID = "S-1-5-32-544";
const FULL_CONTROL = 2_032_127;
const DELETE_SUBDIRECTORIES_AND_FILES = 64;
const CONTAINER_AND_OBJECT_INHERIT = 3;
const INHERIT_ONLY = 2;
const WINDOWS_COMMAND_TIMEOUT_MS = 10_000;
const WINDOWS_COMMAND_MAX_BUFFER_BYTES = 128 * 1024;
const PRIVATE_ASSET_PREFIX = /^[A-Za-z0-9._-]{1,96}$/;
// Raw %LOCALAPPDATA%/%TEMP% are not reliably safe default parents: hosts
// running AppContainer-sandboxed tooling (or anything else that stamps a
// foreign SID with DELETE_SUBDIRECTORIES_AND_FILES on those directories)
// legitimately fail assertParentCannotDeletePrivateChildren on BOTH of
// them. A persistent, protected-DACL bootstrap directory underneath
// LOCALAPPDATA sidesteps that -- it evaluates its own exact policy, not
// whatever the shared user-profile directory happens to carry.
const PRIVATE_ASSET_BOOTSTRAP_PARENT_NAME = "paperclip-private-assets";

interface PathIdentity {
  dev: bigint;
  ino: bigint;
  realPath: string;
}

interface PosixParentSecuritySnapshot {
  uid: number;
  mode: number;
}

interface WindowsAccessRule {
  sid: string;
  inherited: boolean;
  rights: number;
  inheritanceFlags: number;
  propagationFlags: number;
  type: number;
}

interface WindowsDirectorySecuritySnapshot {
  currentUserSid: string;
  ownerSid: string;
  protected: boolean;
  securitySddl: string;
  rules: WindowsAccessRule[];
}

export interface PrivateExecutableAssetDirectory {
  readonly directoryPath: string;
  /**
   * Revalidates parent/directory identity and the private access policy.
   * Call this after populating the directory and before consuming an asset.
   */
  assertIntegrity(): Promise<void>;
  /**
   * Removes this exact directory. Missing/replaced paths and cleanup failures
   * are deliberately surfaced rather than converted into a successful result.
   */
  cleanup(): Promise<void>;
}

export interface CreatePrivateExecutableAssetDirectoryOptions {
  /** A bounded filename prefix; a cryptographically random UUID is appended. */
  prefix: string;
  /** Existing parent. Defaults to a protected Windows bootstrap or the POSIX temp directory. */
  parentDirectory?: string;
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error(
      "Cannot secure private executable-asset directory: SystemRoot is unavailable or not absolute.",
    );
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
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    throw new Error(
      "Cannot secure private executable-asset directory: SystemRoot is unavailable.",
    );
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

function isWindowsAccessRule(value: unknown): value is WindowsAccessRule {
  if (typeof value !== "object" || value === null) return false;
  const rule = value as Partial<WindowsAccessRule>;
  return typeof rule.sid === "string"
    && typeof rule.inherited === "boolean"
    && typeof rule.rights === "number"
    && Number.isInteger(rule.rights)
    && typeof rule.inheritanceFlags === "number"
    && Number.isInteger(rule.inheritanceFlags)
    && typeof rule.propagationFlags === "number"
    && Number.isInteger(rule.propagationFlags)
    && typeof rule.type === "number"
    && Number.isInteger(rule.type);
}

function parseWindowsDirectorySecuritySnapshot(
  output: string,
): WindowsDirectorySecuritySnapshot {
  const parsed = JSON.parse(output.trim().replace(/^\uFEFF/, "")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Private executable-asset access-policy proof was not an object.");
  }
  const snapshot = parsed as Partial<WindowsDirectorySecuritySnapshot>;
  if (
    typeof snapshot.currentUserSid !== "string"
    || typeof snapshot.ownerSid !== "string"
    || typeof snapshot.protected !== "boolean"
    || typeof snapshot.securitySddl !== "string"
    || !Array.isArray(snapshot.rules)
    || !snapshot.rules.every(isWindowsAccessRule)
  ) {
    throw new Error("Private executable-asset access-policy proof was malformed.");
  }
  return snapshot as WindowsDirectorySecuritySnapshot;
}

async function readWindowsDirectorySecurity(
  targetPath: string,
): Promise<WindowsDirectorySecuritySnapshot> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:PAPERCLIP_PRIVATE_ASSET_ACL_TARGET",
    "$acl = [System.IO.Directory]::GetAccessControl($target)",
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
    "$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access",
    "[pscustomobject]@{",
    "  currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "  ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "  protected = $acl.AreAccessRulesProtected",
    "  securitySddl = $acl.GetSecurityDescriptorSddlForm($sections)",
    "  rules = $rules",
    "} | ConvertTo-Json -Depth 5 -Compress",
  ].join("\n");
  const output = await runWindowsPowerShell(script, {
    PAPERCLIP_PRIVATE_ASSET_ACL_TARGET: targetPath,
  });
  return parseWindowsDirectorySecuritySnapshot(output);
}

function windowsSecurityFingerprint(snapshot: WindowsDirectorySecuritySnapshot): string {
  return [
    snapshot.currentUserSid.toUpperCase(),
    snapshot.ownerSid.toUpperCase(),
    snapshot.protected ? "protected" : "inherited",
    snapshot.securitySddl,
  ].join("\n");
}

function assertParentCannotDeletePrivateChildren(
  snapshot: WindowsDirectorySecuritySnapshot,
): void {
  const trustedSids = new Set([
    snapshot.currentUserSid.toUpperCase(),
    LOCAL_SYSTEM_SID,
    BUILTIN_ADMINISTRATORS_SID,
  ]);
  const unsafeRule = snapshot.rules.find((rule) => (
    rule.type === 0
    && (rule.propagationFlags & INHERIT_ONLY) === 0
    && (rule.rights & DELETE_SUBDIRECTORIES_AND_FILES) !== 0
    && !trustedSids.has(rule.sid.toUpperCase())
  ));
  if (unsafeRule) {
    throw new Error(
      `Private executable-asset parent grants DeleteSubdirectoriesAndFiles to untrusted SID ${unsafeRule.sid}; child identity cannot be preserved.`,
    );
  }
}

function assertExactWindowsPrivateDirectoryPolicy(
  snapshot: WindowsDirectorySecuritySnapshot,
  expectedCurrentUserSid: string,
): void {
  const currentUserSid = expectedCurrentUserSid.toUpperCase();
  const allowedSids = new Set([
    currentUserSid,
    LOCAL_SYSTEM_SID,
    BUILTIN_ADMINISTRATORS_SID,
  ]);
  if (
    snapshot.currentUserSid.toUpperCase() !== currentUserSid
    || snapshot.ownerSid.toUpperCase() !== currentUserSid
    || !snapshot.protected
    || snapshot.rules.length !== allowedSids.size
  ) {
    throw new Error(
      "Private executable-asset access-policy verification failed: owner or DACL is not protected and exact.",
    );
  }
  for (const rule of snapshot.rules) {
    if (
      !allowedSids.has(rule.sid.toUpperCase())
      || rule.inherited
      || rule.type !== 0
      || rule.rights !== FULL_CONTROL
      || rule.inheritanceFlags !== CONTAINER_AND_OBJECT_INHERIT
      || rule.propagationFlags !== 0
    ) {
      throw new Error(
        "Private executable-asset access-policy verification failed: unexpected access rule.",
      );
    }
  }
}

async function createWindowsPrivateDirectory(
  directoryPath: string,
  currentUserSid: string,
): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:PAPERCLIP_PRIVATE_ASSET_DIRECTORY_TARGET",
    "$expectedUserSid = $env:PAPERCLIP_PRIVATE_ASSET_CURRENT_USER_SID",
    "$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "if ($currentUserSid -ne $expectedUserSid) { throw 'Private executable-asset process identity changed before creation.' }",
    "if ([System.IO.Directory]::Exists($target) -or [System.IO.File]::Exists($target)) {",
    "  throw 'Private executable-asset target already exists.'",
    "}",
    `$allowedSids = @($currentUserSid, '${LOCAL_SYSTEM_SID}', '${BUILTIN_ADMINISTRATORS_SID}') | Select-Object -Unique`,
    "$aces = @($allowedSids | ForEach-Object { \"(A;OICI;FA;;;$_)\" })",
    "$security = [System.Security.AccessControl.DirectorySecurity]::new()",
    "$security.SetSecurityDescriptorSddlForm(('O:' + $currentUserSid + 'D:P' + ($aces -join '')))",
    // .NET Framework applies the protected DACL in the CreateDirectory syscall;
    // there is no inherited-reader window before the private policy exists.
    "[System.IO.Directory]::CreateDirectory($target, $security) | Out-Null",
  ].join("\n");
  await runWindowsPowerShell(script, {
    PAPERCLIP_PRIVATE_ASSET_DIRECTORY_TARGET: directoryPath,
    PAPERCLIP_PRIVATE_ASSET_CURRENT_USER_SID: currentUserSid,
  });
}

async function pathIdentity(targetPath: string): Promise<PathIdentity> {
  const stat = await fs.lstat(targetPath, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    realPath: await fs.realpath(targetPath),
  };
}

function sameObjectIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  const sameRealPath = process.platform === "win32"
    ? left.realPath.toLowerCase() === right.realPath.toLowerCase()
    : left.realPath === right.realPath;
  return sameObjectIdentity(left, right) && sameRealPath;
}

async function assertDirectoryAtPath(directoryPath: string): Promise<PathIdentity> {
  const stat = await fs.lstat(directoryPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      "Private executable-asset path must remain a real directory, not a symlink or reparse file.",
    );
  }
  return await pathIdentity(directoryPath);
}

async function assertPosixPrivateDirectory(
  directoryPath: string,
  expectedIdentity: PathIdentity,
  requireSamePath = true,
): Promise<void> {
  const identity = await assertDirectoryAtPath(directoryPath);
  if (
    requireSamePath
      ? !samePathIdentity(identity, expectedIdentity)
      : !sameObjectIdentity(identity, expectedIdentity)
  ) {
    throw new Error("Private executable-asset directory identity changed.");
  }
  const stat = await fs.stat(directoryPath);
  const mode = stat.mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(
      `Private executable-asset directory mode verification failed: expected 0700, got ${mode.toString(8)}.`,
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Private executable-asset directory owner identity changed.");
  }
}

async function readPosixParentSecurity(
  parentPath: string,
): Promise<PosixParentSecuritySnapshot> {
  const stat = await fs.stat(parentPath);
  return { uid: stat.uid, mode: stat.mode & 0o7777 };
}

function posixParentSecurityFingerprint(
  snapshot: PosixParentSecuritySnapshot,
): string {
  return `${snapshot.uid}:${snapshot.mode.toString(8)}`;
}

function assertPosixParentMutationAuthority(
  snapshot: PosixParentSecuritySnapshot,
): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid === null) {
    throw new Error(
      "Private executable-asset parent owner cannot be verified on this POSIX runtime.",
    );
  }
  if (snapshot.uid !== currentUid && snapshot.uid !== 0) {
    throw new Error(
      `Private executable-asset parent is owned by untrusted uid ${snapshot.uid}.`,
    );
  }
  const groupOrWorldWritable = (snapshot.mode & 0o022) !== 0;
  const sticky = (snapshot.mode & 0o1000) !== 0;
  if (groupOrWorldWritable && !sticky) {
    throw new Error(
      `Private executable-asset parent grants unsafe group/world mutation authority (mode ${snapshot.mode.toString(8)}).`,
    );
  }
}

async function assertPosixParentSecurityUnchanged(
  parentPath: string,
  expectedFingerprint: string,
): Promise<void> {
  const snapshot = await readPosixParentSecurity(parentPath);
  assertPosixParentMutationAuthority(snapshot);
  if (posixParentSecurityFingerprint(snapshot) !== expectedFingerprint) {
    throw new Error("Private executable-asset parent access policy changed.");
  }
}

async function assertPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Private executable-asset cleanup left the directory in place: ${targetPath}`);
}

async function pathIsMissing(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function cleanupEmptyDirectoryAfterFailedCreation(input: {
  directoryPath: string;
  directoryIdentity: PathIdentity;
  realParent: string;
  parentIdentity: PathIdentity;
  posixParentSecurityFingerprint: string | null;
}): Promise<void> {
  if (!samePathIdentity(input.parentIdentity, await pathIdentity(input.realParent))) {
    throw new Error("Cannot clean failed private asset: parent identity changed.");
  }
  if (process.platform === "win32") {
    assertParentCannotDeletePrivateChildren(
      await readWindowsDirectorySecurity(input.realParent),
    );
  } else {
    await assertPosixParentSecurityUnchanged(
      input.realParent,
      input.posixParentSecurityFingerprint!,
    );
  }
  const currentIdentity = await assertDirectoryAtPath(input.directoryPath);
  if (!samePathIdentity(input.directoryIdentity, currentIdentity)) {
    throw new Error("Cannot clean failed private asset: directory identity changed.");
  }
  if ((await fs.readdir(input.directoryPath)).length !== 0) {
    throw new Error("Cannot clean failed private asset: directory is no longer empty.");
  }

  const cleanupPath = `${input.directoryPath}.failed-${randomUUID()}`;
  await fs.rename(input.directoryPath, cleanupPath);
  const movedIdentity = await assertDirectoryAtPath(cleanupPath);
  if (!sameObjectIdentity(input.directoryIdentity, movedIdentity)) {
    throw new Error("Cannot clean failed private asset: identity changed during rename.");
  }
  await fs.rmdir(cleanupPath);
  await assertPathMissing(cleanupPath);
  await assertPathMissing(input.directoryPath);
}

/**
 * Resolves (bootstrapping on first use) a persistent, protected-DACL
 * directory under %LOCALAPPDATA% to serve as the default Windows parent for
 * createPrivateExecutableAssetDirectory, in place of raw %LOCALAPPDATA%
 * itself. A pre-existing bootstrap directory is verified against the exact
 * expected policy on every call, never trusted blindly -- a directory found
 * at the expected path is only as safe as its actual current DACL.
 */
async function ensureWindowsPrivateAssetParentDirectory(): Promise<string> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("Private executable-asset parent bootstrap requires LOCALAPPDATA.");
  }
  // currentUserSid is this process's own identity, not a property of any
  // particular directory -- readWindowsDirectorySecurity(localAppData) is
  // used here purely to obtain it, not to validate LOCALAPPDATA's own ACL.
  const { currentUserSid } = await readWindowsDirectorySecurity(localAppData);
  const target = path.join(localAppData, PRIVATE_ASSET_BOOTSTRAP_PARENT_NAME);
  if (await pathIsMissing(target)) {
    try {
      await createWindowsPrivateDirectory(target, currentUserSid);
    } catch (error) {
      // Another process may have won a create race between the check above
      // and this call; only swallow the error if the target now exists --
      // any other failure (e.g. a real permission problem) still surfaces.
      if (await pathIsMissing(target)) throw error;
    }
  }
  assertExactWindowsPrivateDirectoryPolicy(
    await readWindowsDirectorySecurity(target),
    currentUserSid,
  );
  return target;
}

/**
 * Creates a randomized, private temporary directory for locally generated
 * executable assets.
 *
 * POSIX mkdtemp starts private and is normalized/read back as mode 0700.
 * Windows uses Directory.CreateDirectory(path, DirectorySecurity), then reads
 * back a protected exact DACL containing only current-user, LocalSystem, and
 * Builtin Administrators inheritable FullControl ACEs. Parent DELETE_CHILD,
 * access-policy tamper, and parent/child identity changes fail closed.
 */
export async function createPrivateExecutableAssetDirectory(
  options: CreatePrivateExecutableAssetDirectoryOptions,
): Promise<PrivateExecutableAssetDirectory> {
  if (!PRIVATE_ASSET_PREFIX.test(options.prefix)) {
    throw new Error("Private executable-asset prefix contains unsupported characters.");
  }

  const parentDirectory = options.parentDirectory
    ?? (process.platform === "win32"
      ? await ensureWindowsPrivateAssetParentDirectory()
      : os.tmpdir());
  if (!parentDirectory) {
    throw new Error("Private executable-asset parent is unavailable.");
  }
  if (!path.isAbsolute(parentDirectory)) {
    throw new Error("Private executable-asset parent must use an absolute path.");
  }
  const parentStat = await fs.lstat(parentDirectory, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Private executable-asset parent must be a real directory.");
  }
  const realParent = await fs.realpath(parentDirectory);
  const parentIdentity = await pathIdentity(realParent);

  let directoryPath: string;
  let expectedCurrentUserSid: string | null = null;
  let parentSecurityFingerprint: string | null = null;
  let expectedPosixParentSecurityFingerprint: string | null = null;

  if (process.platform === "win32") {
    const parentSecurityBefore = await readWindowsDirectorySecurity(realParent);
    assertParentCannotDeletePrivateChildren(parentSecurityBefore);
    expectedCurrentUserSid = parentSecurityBefore.currentUserSid;
    parentSecurityFingerprint = windowsSecurityFingerprint(parentSecurityBefore);
    directoryPath = path.join(realParent, `${options.prefix}${randomUUID()}`);
    await createWindowsPrivateDirectory(directoryPath, expectedCurrentUserSid);
  } else {
    const parentSecurityBefore = await readPosixParentSecurity(realParent);
    assertPosixParentMutationAuthority(parentSecurityBefore);
    expectedPosixParentSecurityFingerprint =
      posixParentSecurityFingerprint(parentSecurityBefore);
    directoryPath = await fs.mkdtemp(path.join(realParent, options.prefix));
    const initialMode = (await fs.stat(directoryPath)).mode & 0o777;
    if ((initialMode & 0o077) !== 0) {
      throw new Error(
        `Private executable-asset directory was created with exposed mode ${initialMode.toString(8)}.`,
      );
    }
    await fs.chmod(directoryPath, 0o700);
  }

  const directoryIdentity = await assertDirectoryAtPath(directoryPath);
  try {
    if (!samePathIdentity(parentIdentity, await pathIdentity(realParent))) {
      throw new Error("Private executable-asset parent identity changed during creation.");
    }

    if (process.platform === "win32") {
      const directorySecurity = await readWindowsDirectorySecurity(directoryPath);
      assertExactWindowsPrivateDirectoryPolicy(directorySecurity, expectedCurrentUserSid!);
      const parentSecurityAfter = await readWindowsDirectorySecurity(realParent);
      assertParentCannotDeletePrivateChildren(parentSecurityAfter);
      if (windowsSecurityFingerprint(parentSecurityAfter) !== parentSecurityFingerprint) {
        throw new Error("Private executable-asset parent access policy changed during creation.");
      }
    } else {
      await assertPosixParentSecurityUnchanged(
        realParent,
        expectedPosixParentSecurityFingerprint!,
      );
      await assertPosixPrivateDirectory(directoryPath, directoryIdentity);
    }
  } catch (error) {
    try {
      await cleanupEmptyDirectoryAfterFailedCreation({
        directoryPath,
        directoryIdentity,
        realParent,
        parentIdentity,
        posixParentSecurityFingerprint: expectedPosixParentSecurityFingerprint,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Private executable-asset creation failed and exact empty cleanup could not complete: ${directoryPath}`,
      );
    }
    throw error;
  }

  const assertIntegrity = async (): Promise<void> => {
    if (!samePathIdentity(parentIdentity, await pathIdentity(realParent))) {
      throw new Error("Private executable-asset parent identity changed.");
    }
    const currentDirectoryIdentity = await assertDirectoryAtPath(directoryPath);
    if (!samePathIdentity(directoryIdentity, currentDirectoryIdentity)) {
      throw new Error("Private executable-asset directory identity changed.");
    }
    if (process.platform === "win32") {
      const parentSecurity = await readWindowsDirectorySecurity(realParent);
      assertParentCannotDeletePrivateChildren(parentSecurity);
      if (windowsSecurityFingerprint(parentSecurity) !== parentSecurityFingerprint) {
        throw new Error("Private executable-asset parent access policy changed.");
      }
      assertExactWindowsPrivateDirectoryPolicy(
        await readWindowsDirectorySecurity(directoryPath),
        expectedCurrentUserSid!,
      );
      return;
    }
    await assertPosixParentSecurityUnchanged(
      realParent,
      expectedPosixParentSecurityFingerprint!,
    );
    await assertPosixPrivateDirectory(directoryPath, directoryIdentity);
  };

  let cleanupState:
    | { state: "active" }
    | { state: "moved"; cleanupPath: string }
    | { state: "removed" } = { state: "active" };
  return {
    directoryPath,
    assertIntegrity,
    cleanup: async () => {
      if (cleanupState.state === "removed") return;
      if (cleanupState.state === "active") {
        await assertIntegrity();
        const cleanupPath = `${directoryPath}.cleanup-${randomUUID()}`;
        await fs.rename(directoryPath, cleanupPath);
        cleanupState = { state: "moved", cleanupPath };
      }

      const { cleanupPath } = cleanupState;
      if (await pathIsMissing(cleanupPath)) {
        // The exact directory was already moved by this cleanup state. If both
        // names are absent, a prior rm completed despite reporting an error.
        await assertPathMissing(directoryPath);
        cleanupState = { state: "removed" };
        return;
      }
      const movedIdentity = await assertDirectoryAtPath(cleanupPath);
      if (!sameObjectIdentity(directoryIdentity, movedIdentity)) {
        throw new Error(
          "Private executable-asset identity changed during cleanup; refusing recursive deletion.",
        );
      }
      if (!samePathIdentity(parentIdentity, await pathIdentity(realParent))) {
        throw new Error(
          "Private executable-asset parent identity changed during cleanup; refusing recursive deletion.",
        );
      }
      if (process.platform === "win32") {
        const parentSecurity = await readWindowsDirectorySecurity(realParent);
        assertParentCannotDeletePrivateChildren(parentSecurity);
        if (windowsSecurityFingerprint(parentSecurity) !== parentSecurityFingerprint) {
          throw new Error(
            "Private executable-asset parent access policy changed during cleanup.",
          );
        }
        assertExactWindowsPrivateDirectoryPolicy(
          await readWindowsDirectorySecurity(cleanupPath),
          expectedCurrentUserSid!,
        );
      } else {
        await assertPosixParentSecurityUnchanged(
          realParent,
          expectedPosixParentSecurityFingerprint!,
        );
        await assertPosixPrivateDirectory(cleanupPath, directoryIdentity, false);
      }
      await fs.rm(cleanupPath, { recursive: true, force: false });
      await assertPathMissing(cleanupPath);
      await assertPathMissing(directoryPath);
      cleanupState = { state: "removed" };
    },
  };
}
