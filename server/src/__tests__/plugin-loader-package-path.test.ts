/**
 * Source-only proposal; adopt under server/src/__tests__ before qualification.
 * New synthetic packages are retained. npm execution is mocked; no worker or DB is supplied.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registry: {
    getById: vi.fn(),
    listInstalled: vi.fn(),
    updateStatus: vi.fn(),
    update: vi.fn<(
      id: string, data: Record<string, unknown>, expected?: Record<string, unknown>,
    ) => Promise<unknown>>(),
  },
  execFile: vi.fn((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => { callback(null, "", ""); return {}; }),
}));

vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mocks.registry }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (input: Parameters<typeof actual.existsSync>[0]) =>
      String(input).replaceAll("\\", "/").endsWith("/npm/bin/npm-cli.js") || actual.existsSync(input),
  };
});

import { pluginLoader } from "../services/plugin-loader.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

const pluginId = "plugin-fixture-1";
const pluginKey = "paperclip.path_persistence_fixture";
const packageName = "paperclip-plugin-path-fixture";
const retainedSyntheticRoots: string[] = [];
const baseManifest = {
  id: pluginKey,
  apiVersion: 1,
  version: "1.0.1",
  displayName: "Path persistence fixture",
  description: "Synthetic local path regression fixture",
  author: "Paperclip fixture",
  categories: ["automation"],
  capabilities: ["companies.read"],
  entrypoints: { worker: "./dist/worker.js" },
};

async function makePackage(root: string, manifest = baseManifest): Promise<void> {
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: packageName,
    version: manifest.version,
    type: "module",
    paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
  }), { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(root, "dist", "manifest.js"),
    `export default ${JSON.stringify(manifest)};\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(root, "dist", "worker.js"), "export {};\n", { encoding: "utf8", flag: "wx" });
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pp-path-preservation-fixture-"));
  retainedSyntheticRoots.push(root);
  return root;
}

function selectExisting(packagePath: string | null, capabilities = baseManifest.capabilities, status = "disabled") {
  mocks.registry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey,
    packageName,
    packagePath,
    status,
    manifestJson: { ...baseManifest, capabilities, version: "1.0.0" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registry.listInstalled.mockResolvedValue([]);
  mocks.registry.update.mockResolvedValue({ id: pluginId, status: "upgrade_pending" });
});

afterAll(() => {
  console.info(JSON.stringify({ caller: "pp-package-path-regression", retainedSyntheticRoots }));
});

describe("plugin loader source-aware packagePath update", () => {
  it("persists an exact replacement local pointer on the same disabled UUID", async () => {
    const root = await makeRoot();
    await makePackage(root);
    selectExisting(path.join(root, "old-retained-pointer"));
    const loader = pluginLoader({} as never, { enableNpmDiscovery: false, enableLocalFilesystem: false });
    const result = await loader.upgradePlugin(pluginId, { localPath: root });
    expect(result.discovered.source).toBe("local-filesystem");
    expect(mocks.registry.update).toHaveBeenCalledTimes(1);
    expect(mocks.registry.update).toHaveBeenCalledWith(pluginId, {
      packageName, packagePath: path.resolve(root), version: baseManifest.version, manifest: baseManifest,
    });
    expect(loader.hasRuntimeServices()).toBe(false);
    expect(mocks.registry.update.mock.calls[0][1]).not.toHaveProperty("status");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("retains stored local selection when localPath is omitted", async () => {
    const root = await makeRoot();
    await makePackage(root);
    selectExisting(root);
    const loader = pluginLoader({} as never, { enableNpmDiscovery: false, enableLocalFilesystem: false });
    await loader.upgradePlugin(pluginId, {});
    expect(mocks.registry.update.mock.calls[0][1].packagePath).toBe(path.resolve(root));
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("keeps registry-backed mode null rather than persisting the npm cache directory", async () => {
    const root = await makeRoot();
    const npmPackageRoot = path.join(root, "node_modules", packageName);
    await makePackage(npmPackageRoot);
    selectExisting(null);
    const loader = pluginLoader({} as never, {
      localPluginDir: root, enableNpmDiscovery: false, enableLocalFilesystem: false,
    });
    const result = await loader.upgradePlugin(pluginId, { version: baseManifest.version });
    expect(result.discovered.source).toBe("npm");
    expect(result.discovered.packagePath).toBe(npmPackageRoot);
    expect(mocks.registry.update.mock.calls[0][1].packagePath).toBeNull();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    const argv = mocks.execFile.mock.calls[0][1];
    expect(argv).toContain("--ignore-scripts");
  });

  it("refuses a different manifest identity before registry mutation", async () => {
    const root = await makeRoot();
    await makePackage(root, { ...baseManifest, id: "paperclip.other_fixture" });
    selectExisting("C:/synthetic/old-retained-pointer");
    const loader = pluginLoader({} as never, { enableNpmDiscovery: false, enableLocalFilesystem: false });
    await expect(loader.upgradePlugin(pluginId, { localPath: root })).rejects.toThrow("does not match");
    expect(mocks.registry.update).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("retains capability-escalation refusal without silently granting or activating", async () => {
    const root = await makeRoot();
    await makePackage(root);
    selectExisting("C:/synthetic/old-retained-pointer", []);
    const loader = pluginLoader({} as never, { enableNpmDiscovery: false, enableLocalFilesystem: false });
    await expect(loader.upgradePlugin(pluginId, { localPath: root })).rejects.toThrow("require approval");
    expect(mocks.registry.update).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("stages added capabilities only under a persisted pending hold", async () => {
    const root = await makeRoot();
    await makePackage(root);
    selectExisting("C:/synthetic/old-retained-pointer", [], "upgrade_pending");
    const loader = pluginLoader({} as never, { enableNpmDiscovery: false, enableLocalFilesystem: false });
    const result = await loader.upgradePlugin(pluginId, { localPath: root, stageForApproval: true });
    expect(result.newManifest.capabilities).toEqual(["companies.read"]);
    expect(mocks.registry.update).toHaveBeenCalledWith(pluginId, {
      packageName, packagePath: path.resolve(root), version: baseManifest.version, manifest: baseManifest,
    }, expect.objectContaining({ status: "upgrade_pending" }));
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("composes disabled lifecycle and real loader staging, with approval only via separate enable", async () => {
    const root = await makeRoot();
    await makePackage(root);
    let row = {
      id: pluginId, pluginKey, packageName, packagePath: "C:/synthetic/old-retained-pointer",
      status: "disabled", version: "1.0.0",
      manifestJson: { ...baseManifest, capabilities: [], version: "1.0.0" },
    };
    const order: string[] = [];
    mocks.registry.getById.mockImplementation(async () => ({ ...row }));
    mocks.registry.updateStatus.mockImplementation(async (_id, change) => {
      order.push(`status:${change.status}`);
      row = { ...row, ...change };
      return { ...row };
    });
    mocks.registry.update.mockImplementation(async (_id, data, expected) => {
      expect(row.status).toBe("upgrade_pending");
      expect(expected).toEqual({ status: "upgrade_pending", manifest: row.manifestJson });
      order.push("replace");
      row = { ...row, ...data, manifestJson: data.manifest as typeof row.manifestJson };
      return { ...row };
    });
    const loader = pluginLoader({} as never, { enableNpmDiscovery: false, enableLocalFilesystem: false });
    vi.spyOn(loader, "hasRuntimeServices").mockReturnValue(true);
    vi.spyOn(loader, "unloadSingle").mockImplementation(async () => { order.push("unload"); });
    const load = vi.spyOn(loader, "loadSingle").mockImplementation(async () => ({
      success: true, plugin: row as never,
      registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
    }));
    const lifecycle = pluginLifecycleManager({} as never, { loader });
    const held = await lifecycle.upgrade(pluginId, undefined, { localPath: root, activate: false });
    expect(order).toEqual(["status:upgrade_pending", "unload", "replace"]);
    expect(held).toMatchObject({ id: pluginId, status: "upgrade_pending", manifestJson: baseManifest });
    expect(load).not.toHaveBeenCalled();
    // Re-reading the now-identical manifest must not implicitly approve it.
    await lifecycle.upgrade(pluginId, undefined, { localPath: root });
    expect(row.status).toBe("upgrade_pending");
    expect(load).not.toHaveBeenCalled();
    await lifecycle.enable(pluginId);
    expect(row.status).toBe("ready");
    expect(load).toHaveBeenCalledExactlyOnceWith(pluginId);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("fails closed when the conditional staging update loses its hold", async () => {
    const root = await makeRoot();
    await makePackage(root);
    selectExisting("C:/synthetic/old-retained-pointer", [], "upgrade_pending");
    mocks.registry.update.mockResolvedValueOnce(null);
    const loader = pluginLoader({} as never, { enableNpmDiscovery: false, enableLocalFilesystem: false });
    await expect(loader.upgradePlugin(pluginId, { localPath: root, stageForApproval: true }))
      .rejects.toThrow("activation hold changed");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each(["ready", "disabled", "error", "installed", "uninstalled"])(
    "refuses staging from %s before package discovery or persistence", async (status) => {
      selectExisting("C:/synthetic/absent", [], status);
      const loader = pluginLoader({} as never, { enableNpmDiscovery: false, enableLocalFilesystem: false });
      await expect(loader.upgradePlugin(pluginId, {
        localPath: "C:/synthetic/absent", stageForApproval: true,
      })).rejects.toThrow("persisted upgrade_pending hold");
      expect(mocks.registry.update).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );
});
