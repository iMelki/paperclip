import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildRemoteGitDeltaBundleScript,
  createImportedGitRef,
  createRemoteGitExportRef,
  deleteLocalGitRef,
  fetchGitBundleIntoLocalRef,
  isMissingGitPrerequisiteError,
  readGitWorkspaceSnapshot,
  readSanitizedOriginRemoteUrl,
  runLocalGit,
  sanitizeGitRemoteUrl,
  withShallowGitWorkspaceClone,
} from "./git-workspace-sync.js";
import { resolveTestShellCommand } from "./test-shell.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runLocalGit(cwd, args)).stdout.trim();
}

describe("git workspace sync", () => {
  const cleanupDirs: string[] = [];
  const isolatedGitEnvNames = [
    "GIT_ATTR_NOSYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
  ] as const;
  const originalGitEnv = new Map<string, string | undefined>();
  let isolatedGitConfigDir = "";
  let hostileSystemConfig = "";

  beforeAll(async () => {
    for (const name of isolatedGitEnvNames) {
      originalGitEnv.set(name, process.env[name]);
    }

    isolatedGitConfigDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-config-"));
    const emptyGlobalConfig = path.join(isolatedGitConfigDir, "global.gitconfig");
    hostileSystemConfig = path.join(isolatedGitConfigDir, "system.gitconfig");
    await writeFile(emptyGlobalConfig, "", "utf8");
    await writeFile(
      hostileSystemConfig,
      '[core]\n\tautocrlf = true\n[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n',
      "utf8",
    );

    process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
    process.env.GIT_CONFIG_SYSTEM = hostileSystemConfig;
    process.env.GIT_ATTR_NOSYSTEM = "1";
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_PARAMETERS;
  });

  afterAll(async () => {
    for (const name of isolatedGitEnvNames) {
      const value = originalGitEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (isolatedGitConfigDir) {
      await rm(isolatedGitConfigDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function createRepo(rootDir: string): Promise<string> {
    const repo = path.join(rootDir, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["checkout", "-b", "main"]);
    await git(repo, ["config", "user.name", "Paperclip Test"]);
    await git(repo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "base"]);
    return repo;
  }

  it("isolates fixture repositories from host Git configuration", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-config-proof-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    const remoteUrl = "https://github.com/example/repo.git";
    await git(repo, ["remote", "add", "origin", remoteUrl]);

    await expect(readFile(hostileSystemConfig, "utf8")).resolves.toContain("autocrlf = true");
    await expect(git(repo, ["config", "--get", "core.autocrlf"])).rejects.toThrow();
    expect(await git(repo, ["remote", "get-url", "origin"])).toBe(remoteUrl);
  });

  it("proves the isolation guard blocks hostile system Git configuration", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-config-negative-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    const remoteUrl = "https://github.com/example/repo.git";
    await git(repo, ["remote", "add", "origin", remoteUrl]);

    const rawGit = (await execFile("git", ["-C", repo, "config", "--get", "core.autocrlf"])).stdout.trim();
    expect(rawGit).toBe("true");
    const rawRemote = (await execFile("git", ["-C", repo, "remote", "get-url", "origin"])).stdout.trim();
    expect(rawRemote).toBe("git@github.com:example/repo.git");
    await expect(git(repo, ["config", "--get", "core.autocrlf"])).rejects.toThrow();
    expect(await readSanitizedOriginRemoteUrl(repo)).toBe(remoteUrl);
  });

  it("derives the bundle parent directory portably for a backslash Windows bundle path", () => {
    // A missing backslash-form parent is the regression shape: posix.dirname
    // on `C:\work\missing\bundle.bundle` returns ".", so the script would
    // mkdir "." while Git writes the bundle to `/c/work/missing/...`.
    const script = buildRemoteGitDeltaBundleScript({
      remoteDir: "C:\\sandbox\\repo",
      baseSha: "0000000000000000000000000000000000000000",
      exportRef: "refs/paperclip/export/test",
      bundlePath: "C:\\work\\missing\\bundle.bundle",
    });

    expect(script).toContain("mkdir -p '/c/work/missing'");
    expect(script).toContain("rm -f '/c/work/missing/bundle.bundle'");
    expect(script).not.toContain("mkdir -p '.'");
    expect(script).not.toContain("C:\\");

    const posixScript = buildRemoteGitDeltaBundleScript({
      remoteDir: "/sandbox/repo",
      baseSha: "0000000000000000000000000000000000000000",
      exportRef: "refs/paperclip/export/test",
      bundlePath: "/tmp/work/missing/bundle.bundle",
    });

    expect(posixScript).toContain("mkdir -p '/tmp/work/missing'");
  });

  it("creates a shallow standalone clone from the local HEAD snapshot", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-sync-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);
    await rm(path.join(repo, "tracked.txt"));

    const snapshot = await readGitWorkspaceSnapshot(repo);
    expect(snapshot).toMatchObject({
      headCommit: baseHead,
      branchName: "main",
      deletedPaths: ["tracked.txt"],
    });

    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      expect((await lstat(path.join(cloneDir, ".git"))).isDirectory()).toBe(true);
      await expect(readFile(path.join(cloneDir, ".git", "shallow"), "utf8")).resolves.toContain(baseHead);
      expect(await git(cloneDir, ["rev-list", "--count", "HEAD"])).toBe("1");
      expect(await git(cloneDir, ["branch", "--show-current"])).toBe("main");
      await expect(readFile(path.join(cloneDir, "tracked.txt"), "utf8")).resolves.toBe("base\n");
    });
  });

  it("copies the workspace origin remote into the shallow clone", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-origin-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await git(repo, ["remote", "add", "origin", "https://github.com/example/repo.git"]);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      expect(await git(cloneDir, ["remote", "get-url", "origin"])).toBe("https://github.com/example/repo.git");
    });
  });

  it("scrubs credentials from the origin remote before copying it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-origin-scrub-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await git(repo, ["remote", "add", "origin", "https://x-access-token:sekret@github.com/example/repo.git"]);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      expect(await git(cloneDir, ["remote", "get-url", "origin"])).toBe("https://github.com/example/repo.git");
    });
  });

  it("leaves the shallow clone remote-less when the workspace has no origin", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-no-origin-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      await expect(git(cloneDir, ["remote", "get-url", "origin"])).rejects.toThrow();
    });
  });

  it("drops a filesystem-path origin instead of copying it into the shallow clone", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-path-origin-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await git(repo, ["remote", "add", "origin", path.join(rootDir, "elsewhere.git")]);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      await expect(git(cloneDir, ["remote", "get-url", "origin"])).rejects.toThrow();
    });
  });

  it("pushes new commits from the shallow clone to an origin that holds the base commit", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-shallow-push-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    const upstream = path.join(rootDir, "upstream.git");
    await mkdir(upstream, { recursive: true });
    await git(upstream, ["init", "--bare"]);
    await git(repo, ["remote", "add", "origin", upstream]);
    await git(repo, ["push", "origin", "main"]);
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);

    const snapshot = await readGitWorkspaceSnapshot(repo);
    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (cloneDir) => {
      await git(cloneDir, ["config", "user.name", "Paperclip Sandbox"]);
      await git(cloneDir, ["config", "user.email", "sandbox@paperclip.dev"]);
      await writeFile(path.join(cloneDir, "change.txt"), "sandbox change\n", "utf8");
      await git(cloneDir, ["add", "change.txt"]);
      await git(cloneDir, ["commit", "-m", "sandbox change"]);
      const cloneHead = await git(cloneDir, ["rev-parse", "HEAD"]);

      // A filesystem-path origin is dropped by the allowlist, so configure the
      // remote explicitly — the property under test is the push itself: the
      // clone is shallow (single grafted commit), but the boundary commit
      // already exists on the origin, so the push pack closes without full
      // ancestry. That is what makes transported branches publishable.
      await git(cloneDir, ["remote", "add", "origin", upstream]);
      await git(cloneDir, ["push", "origin", "HEAD:refs/heads/sandbox-change"]);

      expect(await git(upstream, ["rev-parse", "refs/heads/sandbox-change"])).toBe(cloneHead);
      expect(await git(upstream, ["merge-base", "refs/heads/main", "refs/heads/sandbox-change"])).toBe(baseHead);
    });
  });

  it("builds thin git delta bundles relative to the imported base", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-delta-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    const baseHead = await git(repo, ["rev-parse", "HEAD"]);
    const snapshot = await readGitWorkspaceSnapshot(repo);
    expect(snapshot).not.toBeNull();

    await withShallowGitWorkspaceClone({
      localDir: repo,
      snapshot: snapshot!,
    }, async (remoteDir) => {
      const emptyBundle = path.join(rootDir, "empty.bundle");
      await execFile(resolveTestShellCommand("sh"), ["-c", buildRemoteGitDeltaBundleScript({
        remoteDir,
        baseSha: baseHead,
        exportRef: createRemoteGitExportRef("test"),
        bundlePath: emptyBundle,
      })]);
      expect((await stat(emptyBundle)).size).toBe(0);

      await git(remoteDir, ["config", "user.name", "Paperclip Remote"]);
      await git(remoteDir, ["config", "user.email", "remote@paperclip.dev"]);
      await writeFile(path.join(remoteDir, "tracked.txt"), "remote\n", "utf8");
      await git(remoteDir, ["commit", "-am", "remote update"]);
      const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);

      const deltaBundle = path.join(rootDir, "delta.bundle");
      const importedRef = createImportedGitRef("test");
      const exportRef = createRemoteGitExportRef("test");
      try {
        await execFile(resolveTestShellCommand("sh"), ["-c", buildRemoteGitDeltaBundleScript({
          remoteDir,
          baseSha: baseHead,
          exportRef,
          bundlePath: deltaBundle,
        })]);
        expect((await stat(deltaBundle)).size).toBeGreaterThan(0);

        const importedHead = await fetchGitBundleIntoLocalRef({
          localDir: repo,
          bundlePath: deltaBundle,
          exportRef,
          importedRef,
          baseSha: baseHead,
        });
        expect(importedHead).toBe(remoteHead);
        expect(await git(repo, ["rev-list", "--count", importedRef, "--not", baseHead])).toBe("1");
      } finally {
        await deleteLocalGitRef({ localDir: repo, ref: importedRef });
      }
    });
    // Real clone/bundle/fetch I/O against the filesystem. Measured 4.4 s on
    // Windows, i.e. straddling vitest's 5 s default — it passed or flaked
    // depending on machine load. Give it headroom instead of leaving a coin
    // flip in the suite. (#63; see #20 for the wider timeout-flake sweep.)
  }, 30_000);

  it("imports a diverged sandbox HEAD even when the host no longer holds baseSha", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-diverge-"));
    cleanupDirs.push(rootDir);
    // Host holds only the shared ancestor B (the eventual merge-base), not the
    // recorded base H — the state a shared workspace lands in when it is reset
    // between export and import.
    const host = await createRepo(rootDir);
    const mergeBase = await git(host, ["rev-parse", "HEAD"]);

    // Sandbox holds B, an advanced commit H (the recorded baseSha), and a
    // local-only commit S that forked from B and diverges from H.
    const sandbox = path.join(rootDir, "sandbox");
    await git(rootDir, ["clone", host, sandbox]);
    await git(sandbox, ["config", "user.name", "Paperclip Remote"]);
    await git(sandbox, ["config", "user.email", "remote@paperclip.dev"]);
    await writeFile(path.join(sandbox, "advance.txt"), "advance\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "advance"]);
    const baseSha = await git(sandbox, ["rev-parse", "HEAD"]);
    await git(sandbox, ["reset", "--hard", mergeBase]);
    await writeFile(path.join(sandbox, "local.txt"), "local\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "local-only"]);
    const sandboxHead = await git(sandbox, ["rev-parse", "HEAD"]);

    // The host genuinely lacks baseSha; the old thin bundle would name it as an
    // unsatisfiable prerequisite.
    await expect(git(host, ["cat-file", "-e", `${baseSha}^{commit}`])).rejects.toThrow();

    const bundle = path.join(rootDir, "diverge.bundle");
    const exportRef = createRemoteGitExportRef("test");
    const importedRef = createImportedGitRef("test");
    try {
      await execFile(resolveTestShellCommand("sh"), ["-c", buildRemoteGitDeltaBundleScript({
        remoteDir: sandbox,
        baseSha,
        exportRef,
        bundlePath: bundle,
      })]);
      expect((await stat(bundle)).size).toBeGreaterThan(0);

      const importedHead = await fetchGitBundleIntoLocalRef({
        localDir: host,
        bundlePath: bundle,
        exportRef,
        importedRef,
        baseSha,
      });
      expect(importedHead).toBe(sandboxHead);
      // The host received the local-only commit and its parent (the merge-base).
      expect(await git(host, ["cat-file", "-e", `${sandboxHead}^{commit}`])).toBe("");
    } finally {
      await deleteLocalGitRef({ localDir: host, ref: importedRef });
    }
  });

  it("re-exports a full bundle that imports when the host holds neither baseSha nor the merge-base", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-ancestor-"));
    cleanupDirs.push(rootDir);
    // Host was reset to a strict ancestor of the eventual merge-base: it holds
    // only the very first commit, not baseSha and not the fork point.
    const host = await createRepo(rootDir);
    const ancestor = await git(host, ["rev-parse", "HEAD"]);

    const sandbox = path.join(rootDir, "sandbox");
    await git(rootDir, ["clone", host, sandbox]);
    await git(sandbox, ["config", "user.name", "Paperclip Remote"]);
    await git(sandbox, ["config", "user.email", "remote@paperclip.dev"]);
    // Advance the merge-base past the host, then baseSha past that, then a
    // divergent local commit — so merge-base(baseSha, HEAD) is itself a commit
    // the host does not hold.
    await writeFile(path.join(sandbox, "fork.txt"), "fork\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "fork point"]);
    const forkPoint = await git(sandbox, ["rev-parse", "HEAD"]);
    await writeFile(path.join(sandbox, "advance.txt"), "advance\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "advance"]);
    const baseSha = await git(sandbox, ["rev-parse", "HEAD"]);
    await git(sandbox, ["reset", "--hard", forkPoint]);
    await writeFile(path.join(sandbox, "local.txt"), "local\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "local-only"]);
    const sandboxHead = await git(sandbox, ["rev-parse", "HEAD"]);

    // Host holds only the initial commit; it lacks both baseSha and the fork point.
    expect(await git(host, ["rev-parse", "HEAD"])).toBe(ancestor);
    await expect(git(host, ["cat-file", "-e", `${forkPoint}^{commit}`])).rejects.toThrow();

    const exportRef = createRemoteGitExportRef("test");
    const importedRef = createImportedGitRef("test");

    // The delta bundle (relative to the merge-base = fork point) names a
    // prerequisite the host lacks, so its import fails and is detected.
    const deltaBundle = path.join(rootDir, "delta.bundle");
    await execFile(resolveTestShellCommand("sh"), ["-c", buildRemoteGitDeltaBundleScript({
      remoteDir: sandbox,
      baseSha,
      exportRef,
      bundlePath: deltaBundle,
    })]);
    let deltaError: unknown;
    try {
      await fetchGitBundleIntoLocalRef({ localDir: host, bundlePath: deltaBundle, exportRef, importedRef, baseSha });
    } catch (error) {
      deltaError = error;
    }
    expect(deltaError).toBeDefined();
    expect(isMissingGitPrerequisiteError(deltaError)).toBe(true);

    // The forced full bundle is self-contained and imports into the same host.
    const fullBundle = path.join(rootDir, "full.bundle");
    try {
      await execFile(resolveTestShellCommand("sh"), ["-c", buildRemoteGitDeltaBundleScript({
        remoteDir: sandbox,
        baseSha,
        exportRef,
        bundlePath: fullBundle,
        forceFullBundle: true,
      })]);
      const importedHead = await fetchGitBundleIntoLocalRef({
        localDir: host,
        bundlePath: fullBundle,
        exportRef,
        importedRef,
        baseSha,
      });
      expect(importedHead).toBe(sandboxHead);
    } finally {
      await deleteLocalGitRef({ localDir: host, ref: importedRef });
    }
    // Same real-git I/O cost as the thin-bundle test above; measured 5.2 s on
    // Windows, just over vitest's 5 s default. (#63)
  }, 30_000);

  it("falls back to a full self-contained bundle when the sandbox lacks baseSha", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-full-"));
    cleanupDirs.push(rootDir);
    const sandbox = await createRepo(rootDir);
    await writeFile(path.join(sandbox, "more.txt"), "more\n", "utf8");
    await git(sandbox, ["add", "-A"]);
    await git(sandbox, ["commit", "-m", "more"]);
    const sandboxHead = await git(sandbox, ["rev-parse", "HEAD"]);

    // A fresh, unrelated host that shares no history with the sandbox.
    const host = path.join(rootDir, "fresh-host");
    await mkdir(host, { recursive: true });
    await git(host, ["init"]);

    const bundle = path.join(rootDir, "full.bundle");
    const exportRef = createRemoteGitExportRef("test");
    const importedRef = createImportedGitRef("test");
    try {
      await execFile(resolveTestShellCommand("sh"), ["-c", buildRemoteGitDeltaBundleScript({
        remoteDir: sandbox,
        // A base the sandbox does not have forces the full-bundle fallback.
        baseSha: "0000000000000000000000000000000000000000",
        exportRef,
        bundlePath: bundle,
      })]);
      expect((await stat(bundle)).size).toBeGreaterThan(0);

      const importedHead = await fetchGitBundleIntoLocalRef({
        localDir: host,
        bundlePath: bundle,
        exportRef,
        importedRef,
        baseSha: "0000000000000000000000000000000000000000",
      });
      expect(importedHead).toBe(sandboxHead);
    } finally {
      await deleteLocalGitRef({ localDir: host, ref: importedRef });
    }
  });
});

describe("sanitizeGitRemoteUrl", () => {
  it("strips userinfo, query, and fragment from http(s) URLs", () => {
    expect(sanitizeGitRemoteUrl("https://x-access-token:sekret@github.com/example/repo.git"))
      .toBe("https://github.com/example/repo.git");
    expect(sanitizeGitRemoteUrl("https://sekret-token@github.com/example/repo.git"))
      .toBe("https://github.com/example/repo.git");
    expect(sanitizeGitRemoteUrl("http://user:pass@git.internal/example/repo.git"))
      .toBe("http://git.internal/example/repo.git");
    expect(sanitizeGitRemoteUrl("https://github.com/example/repo.git?private_token=sekret#fragment"))
      .toBe("https://github.com/example/repo.git");
  });

  it("strips password and query from ssh-scheme URLs but keeps the username", () => {
    expect(sanitizeGitRemoteUrl("ssh://git@github.com/example/repo.git"))
      .toBe("ssh://git@github.com/example/repo.git");
    expect(sanitizeGitRemoteUrl("ssh://git:sekret@github.com/example/repo.git"))
      .toBe("ssh://git@github.com/example/repo.git");
    expect(sanitizeGitRemoteUrl("git+ssh://git@github.com/example/repo.git?key=sekret"))
      .toBe("git+ssh://git@github.com/example/repo.git");
  });

  it("keeps credential-free scp-like remotes unchanged", () => {
    expect(sanitizeGitRemoteUrl("git@github.com:example/repo.git"))
      .toBe("git@github.com:example/repo.git");
    expect(sanitizeGitRemoteUrl("https://github.com/example/repo.git"))
      .toBe("https://github.com/example/repo.git");
  });

  it("drops every shape whose credential surface is unknown", () => {
    // Filesystem paths are useless on the execution host and could leak
    // host-layout details; unknown schemes and malformed userinfo could carry
    // embedded secrets the sanitizer cannot recognize. All fail closed.
    expect(sanitizeGitRemoteUrl("/tmp/local/upstream.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("ftp://user:pass@host/repo.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("user:pass@host:path/repo.git")).toBeNull();
    expect(sanitizeGitRemoteUrl("host.example:path/repo.git")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(sanitizeGitRemoteUrl("")).toBeNull();
    expect(sanitizeGitRemoteUrl("   ")).toBeNull();
  });
});
