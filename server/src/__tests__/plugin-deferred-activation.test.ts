import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  getById: vi.fn(), updateStatus: vi.fn(),
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";

function fixture(status = "ready", newCaps: string[] = []) {
  let row = {
    id: "plugin-1", pluginKey: "example.plugin", status,
    packageName: "@example/plugin", packagePath: "/retained/old",
    version: "1.0.0", manifestJson: { id: "example.plugin", capabilities: [] as string[], version: "1.0.0" },
  };
  const order: string[] = [];
  registry.getById.mockImplementation(async () => ({ ...row }));
  registry.updateStatus.mockImplementation(async (_id, change) => {
    order.push(`status:${change.status}`);
    row = { ...row, ...change };
    return { ...row };
  });
  const loader = {
    hasRuntimeServices: vi.fn(() => true),
    unloadSingle: vi.fn(async () => { order.push("unload"); }),
    loadSingle: vi.fn(async () => ({ success: true, plugin: row, error: undefined as string | undefined })),
    upgradePlugin: vi.fn(async () => {
      order.push("replace");
      const oldManifest = row.manifestJson;
      const newManifest = { id: row.pluginKey, capabilities: newCaps, version: "2.0.0" };
      row = { ...row, version: "2.0.0", packagePath: "/retained/new", manifestJson: newManifest };
      return {
        oldManifest,
        newManifest,
        discovered: { version: "2.0.0" },
      };
    }),
  };
  const lifecycle = pluginLifecycleManager({} as never, { loader: loader as unknown as PluginLoader });
  return { lifecycle, loader, order, row: () => ({ ...row }) };
}

beforeEach(() => vi.resetAllMocks());

describe("explicit deferred plugin activation", () => {
  it("holds before unload, retains identity and replacement path, and enables separately", async () => {
    const f = fixture();
    const result = await f.lifecycle.upgrade("plugin-1", undefined, {
      localPath: "/retained/new", activate: false,
    });
    expect(f.order).toEqual(["status:upgrade_pending", "unload", "replace"]);
    expect(f.loader.upgradePlugin).toHaveBeenCalledWith("plugin-1", {
      version: undefined, localPath: "/retained/new", stageForApproval: true,
    });
    expect(result).toMatchObject({ id: "plugin-1", status: "upgrade_pending", packagePath: "/retained/new" });
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
    await f.lifecycle.enable("plugin-1");
    expect(f.row().status).toBe("ready");
    expect(f.loader.loadSingle).toHaveBeenCalledExactlyOnceWith("plugin-1");
  });

  it("stages the same disabled identity without briefly enabling its old worker", async () => {
    const f = fixture("disabled");
    const result = await f.lifecycle.upgrade("plugin-1", undefined, { activate: false });
    expect(f.order).toEqual(["status:upgrade_pending", "unload", "replace"]);
    expect(result).toMatchObject({ id: "plugin-1", status: "upgrade_pending", version: "2.0.0" });
    expect(f.loader.upgradePlugin).toHaveBeenCalledWith("plugin-1", {
      version: undefined, stageForApproval: true,
    });
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
  });

  it.each([undefined, true])("refuses disabled activation %s before mutation", async (activate) => {
    const f = fixture("disabled");
    await expect(f.lifecycle.upgrade("plugin-1", undefined, { activate })).rejects.toThrow("Cannot upgrade");
    expect(f.order).toEqual([]);
    expect(f.loader.upgradePlugin).not.toHaveBeenCalled();
  });

  it("does not treat a repeated pending upgrade as capability approval", async () => {
    const f = fixture("upgrade_pending");
    const result = await f.lifecycle.upgrade("plugin-1", "2.0.0");
    expect(result.status).toBe("upgrade_pending");
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
    expect(f.order).toEqual(["unload", "replace"]);
  });

  it("keeps an ordinary upgrade with new capabilities pending until explicit enable", async () => {
    const f = fixture("ready", ["companies.read"]);
    const result = await f.lifecycle.upgrade("plugin-1", "2.0.0");
    expect(result).toMatchObject({ status: "upgrade_pending", manifestJson: { capabilities: ["companies.read"] } });
    expect(f.order).toEqual(["status:upgrade_pending", "unload", "replace"]);
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
    await f.lifecycle.enable("plugin-1");
    expect(f.loader.loadSingle).toHaveBeenCalledExactlyOnceWith("plugin-1");
  });

  it("does not activate or emit enabled when the reviewed manifest snapshot is stale", async () => {
    const f = fixture("upgrade_pending");
    const enabled = vi.fn();
    f.lifecycle.on("plugin.enabled", enabled);
    registry.updateStatus.mockRejectedValueOnce(new Error("Plugin activation hold changed"));
    await expect(f.lifecycle.enable("plugin-1")).rejects.toThrow("activation hold changed");
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
    expect(registry.updateStatus).toHaveBeenCalledWith("plugin-1", {
      status: "ready", lastError: null,
    }, { status: "upgrade_pending", manifest: f.row().manifestJson });
  });

  it("refuses activation if another staged manifest replaced this upgrade", async () => {
    const f = fixture();
    registry.getById.mockResolvedValueOnce(f.row()).mockResolvedValueOnce({
      ...f.row(), status: "upgrade_pending",
      manifestJson: { ...f.row().manifestJson, capabilities: ["companies.read"] },
    });
    await expect(f.lifecycle.upgrade("plugin-1", "2.0.0")).rejects.toThrow("Staged plugin manifest changed");
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
  });

  it.each(["unload", "replace"])("retains a disabled upgrade hold after %s fails", async (stage) => {
    const f = fixture("disabled");
    if (stage === "unload") f.loader.unloadSingle.mockRejectedValueOnce(new Error("stage failed"));
    else f.loader.upgradePlugin.mockRejectedValueOnce(new Error("stage failed"));
    await expect(f.lifecycle.upgrade("plugin-1", undefined, { activate: false })).rejects.toThrow("stage failed");
    expect(f.row().status).toBe("upgrade_pending");
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
  });

  it.each(["unload", "replace"])("keeps the hold when %s fails", async (stage) => {
    const f = fixture();
    const error = new Error(`${stage} failed`);
    if (stage === "unload") f.loader.unloadSingle.mockRejectedValueOnce(error);
    else f.loader.upgradePlugin.mockRejectedValueOnce(error);
    await expect(f.lifecycle.upgrade("plugin-1", undefined, { activate: false })).rejects.toThrow(error);
    expect(f.row().status).toBe("upgrade_pending");
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
    if (stage === "unload") expect(f.loader.upgradePlugin).not.toHaveBeenCalled();
  });

  it("refuses deferred replacement without the runtime owner before any mutation", async () => {
    const f = fixture();
    f.loader.hasRuntimeServices.mockReturnValue(false);
    await expect(f.lifecycle.upgrade("plugin-1", undefined, { activate: false }))
      .rejects.toThrow("configured plugin runtime owner");
    expect(f.order).toEqual([]);
    expect(f.loader.upgradePlugin).not.toHaveBeenCalled();
  });

  it("refuses a runtime owner without its unload seam", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.loader, "unloadSingle");
    await expect(f.lifecycle.upgrade("plugin-1", undefined, { activate: false }))
      .rejects.toThrow("configured plugin runtime owner");
    expect(f.order).toEqual([]);
  });

  it("does not report success if the saved activation hold changed", async () => {
    const f = fixture();
    registry.getById.mockResolvedValueOnce(f.row()).mockResolvedValueOnce({ ...f.row(), status: "ready" });
    await expect(f.lifecycle.upgrade("plugin-1", undefined, { activate: false }))
      .rejects.toThrow("lost its activation hold");
    expect(f.loader.loadSingle).not.toHaveBeenCalled();
  });

  it("enables a first installed package through the existing explicit action", async () => {
    const f = fixture("installed");
    await f.lifecycle.enable("plugin-1");
    expect(f.row().status).toBe("ready");
    expect(f.loader.loadSingle).toHaveBeenCalledExactlyOnceWith("plugin-1");
  });

  it("retains immediate activation for legacy upgrade requests", async () => {
    const f = fixture();
    await f.lifecycle.upgrade("plugin-1", "2.0.0");
    expect(f.order).toEqual(["status:upgrade_pending", "unload", "replace", "status:ready"]);
    expect(f.loader.loadSingle).toHaveBeenCalledExactlyOnceWith("plugin-1");
  });

  it.each(["thrown", "returned-false", "failed-cleanup"])(
    "persists a non-ready state when installed enable fails via %s", async (failure) => {
      const f = fixture("installed");
      const enabled = vi.fn();
      f.lifecycle.on("plugin.enabled", enabled);
      if (failure === "thrown") f.loader.loadSingle.mockRejectedValueOnce(new Error("activation failed"));
      else {
        f.loader.loadSingle.mockImplementationOnce(async () => {
          if (failure === "failed-cleanup") {
            f.loader.unloadSingle.mockRejectedValueOnce(new Error("runtime drain failed"));
            try { await f.loader.unloadSingle(); } catch { /* Model loader's failed pre-error cleanup. */ }
          }
          return { success: false, plugin: f.row(), error: "activation failed" };
        });
      }
      await expect(f.lifecycle.enable("plugin-1")).rejects.toThrow("activation failed");
      expect(f.row()).toMatchObject({ status: "error", lastError: "activation failed" });
      expect(f.order).toEqual(["status:ready", "status:error"]);
      expect(enabled).not.toHaveBeenCalled();
      // The lifecycle must save the refusal without depending on an additional unload.
      expect(f.loader.unloadSingle).toHaveBeenCalledTimes(failure === "failed-cleanup" ? 1 : 0);
    },
  );
});
