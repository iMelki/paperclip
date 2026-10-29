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
    update: vi.fn<(id: string, data: Record<string, unknown>) => Promise<unknown>>(),
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

function selectExisting(packagePath: string | null, capabilities = baseManifest.capabilities) {
  mocks.registry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey,
    packageName,
    packagePath,
    status: "disabled",
    manifestJson: { ...baseManifest, capabilities, version: "1.0.0" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registry.listInstalled.mockResolvedValue([]);
  mocks.registry.update.mockResolvedValue(undefined);
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
});
