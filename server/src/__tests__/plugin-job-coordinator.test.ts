import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginJobDeclaration } from "@paperclipai/shared";
import type { PluginJobCoordinatorOptions } from "../services/plugin-job-coordinator.js";

const mocks = vi.hoisted(() => ({ getById: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({ getById: mocks.getById }),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: mocks.info, warn: mocks.warn, error: mocks.error }) },
}));
import { createPluginJobCoordinator } from "../services/plugin-job-coordinator.js";

type Listener = (payload: Record<string, unknown>) => void;
const payload = { pluginId: "11111111-1111-4111-8111-111111111111", pluginKey: "paperclip-github-plugin" };
const declaredJobs: PluginJobDeclaration[] = [{ jobKey: "declared", displayName: "Declared job", schedule: "0 * * * *" }];
const coordinators: Array<ReturnType<typeof createPluginJobCoordinator>> = [];
function fixture(withBridge = false) {
  const listeners = new Map<string, Listener>();
  const lifecycle = {
    on: vi.fn((event: string, listener: Listener) => { listeners.set(event, listener); }),
    off: vi.fn((event: string, listener: Listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    }),
  };
  const scheduler = { registerPlugin: vi.fn(async (): Promise<void> => {}), unregisterPlugin: vi.fn(async (): Promise<void> => {}) };
  const jobStore = { syncJobDeclarations: vi.fn(async (): Promise<void> => {}), deleteAllJobs: vi.fn(async (): Promise<void> => {}) };
  const reconciledJobs: PluginJobDeclaration[] = [{ jobKey: "sync.github-project-board", displayName: "Host board job", scope: "company", schedule: "*/5 * * * *" }];
  const native = { reconcileDeclarations: vi.fn(async () => reconciledJobs) };
  mocks.getById.mockResolvedValue({ manifestJson: { jobs: declaredJobs } });
  // The lifecycle/scheduler/store doubles implement only the coordinator ports.
  // No database, worker, timer, provider adapter or application process is started.
  const options = {
    db: {}, lifecycle, scheduler, jobStore,
    ...(withBridge ? { nativeGitHubProjectBoard: native } : {}),
  } as unknown as PluginJobCoordinatorOptions;
  const coordinator = createPluginJobCoordinator(options);
  coordinators.push(coordinator);
  coordinator.start();
  return { coordinator, lifecycle, listeners, scheduler, jobStore, native, reconciledJobs,
    emit: (event: string, extra: Record<string, unknown> = {}) => listeners.get(event)?.({ ...payload, ...extra }) };
}
async function eventually(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 5 });
}
beforeEach(() => { vi.clearAllMocks(); mocks.getById.mockReset(); });
afterEach(() => { for (const coordinator of coordinators.splice(0)) coordinator.stop(); });

describe("plugin job coordinator lifecycle contract", () => {
  it("attaches once and removes the exact listener identities once", () => {
    const f = fixture();
    f.coordinator.start();
    expect(f.lifecycle.on.mock.calls.map(([event]) => event)).toEqual(["plugin.loaded", "plugin.disabled", "plugin.unloaded"]);
    f.coordinator.stop();
    f.coordinator.stop();
    expect(f.lifecycle.off.mock.calls).toEqual(f.lifecycle.on.mock.calls);
    expect(f.listeners.size).toBe(0);
    f.emit("plugin.disabled");
    expect(f.scheduler.unregisterPlugin).not.toHaveBeenCalled();
  });

  it("waits for declaration persistence before registering a loaded plugin", async () => {
    const f = fixture();
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => { release = resolve; });
    f.jobStore.syncJobDeclarations.mockImplementation(() => persisted);
    try {
      f.emit("plugin.loaded");
      await eventually(() => expect(f.jobStore.syncJobDeclarations).toHaveBeenCalledWith(payload.pluginId, declaredJobs));
      expect(f.scheduler.registerPlugin).not.toHaveBeenCalled();
    } finally { release(); }
    await eventually(() => expect(f.scheduler.registerPlugin).toHaveBeenCalledWith(payload.pluginId));
  });

  it("uses host-reconciled declarations before registering the plugin", async () => {
    const f = fixture(true);
    f.emit("plugin.loaded");
    await eventually(() => expect(f.scheduler.registerPlugin).toHaveBeenCalledWith(payload.pluginId));
    expect(f.native.reconcileDeclarations).toHaveBeenCalledWith(payload.pluginId, payload.pluginKey, declaredJobs);
    expect(f.jobStore.syncJobDeclarations).toHaveBeenCalledWith(payload.pluginId, f.reconciledJobs);
    expect(f.reconciledJobs[0].scope).toBe("company");
    expect(f.jobStore.syncJobDeclarations.mock.invocationCallOrder[0]).toBeLessThan(f.scheduler.registerPlugin.mock.invocationCallOrder[0]);
  });

  it("registers an empty manifest without creating declarations", async () => {
    const f = fixture();
    mocks.getById.mockResolvedValue({ manifestJson: {} });
    f.emit("plugin.loaded");
    await eventually(() => expect(f.scheduler.registerPlugin).toHaveBeenCalledWith(payload.pluginId));
    expect(f.jobStore.syncJobDeclarations).not.toHaveBeenCalled();
  });

  it("leaves missing manifests unscheduled", async () => {
    const f = fixture(true);
    mocks.getById.mockResolvedValue(null);
    f.emit("plugin.loaded");
    await eventually(() => expect(mocks.warn).toHaveBeenCalled());
    expect(f.native.reconcileDeclarations).not.toHaveBeenCalled();
    expect(f.jobStore.syncJobDeclarations).not.toHaveBeenCalled();
    expect(f.scheduler.registerPlugin).not.toHaveBeenCalled();
  });

  it.each(["registry", "reconcile", "persist"] as const)("does not register after a %s failure", async (stage) => {
    const f = fixture(true);
    const failure = new Error("synthetic lifecycle failure");
    if (stage === "registry") mocks.getById.mockRejectedValue(failure);
    if (stage === "reconcile") f.native.reconcileDeclarations.mockRejectedValue(failure);
    if (stage === "persist") f.jobStore.syncJobDeclarations.mockRejectedValue(failure);
    f.emit("plugin.loaded");
    await eventually(() => expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ err: failure.message }), expect.any(String)));
    expect(f.scheduler.registerPlugin).not.toHaveBeenCalled();
    if (stage !== "persist") expect(f.jobStore.syncJobDeclarations).not.toHaveBeenCalled();
  });

  it("unregisters a disabled plugin without deleting its history", async () => {
    const f = fixture();
    f.emit("plugin.disabled", { reason: "operator disabled" });
    await eventually(() => expect(f.scheduler.unregisterPlugin).toHaveBeenCalledWith(payload.pluginId));
    expect(f.jobStore.deleteAllJobs).not.toHaveBeenCalled();
  });

  it.each([false, true])("unloads and purges only when removeData is %s", async (removeData) => {
    const f = fixture();
    f.emit("plugin.unloaded", { removeData });
    await eventually(() => expect(f.scheduler.unregisterPlugin).toHaveBeenCalledWith(payload.pluginId));
    if (removeData) {
      await eventually(() => expect(f.jobStore.deleteAllJobs).toHaveBeenCalledWith(payload.pluginId));
      expect(f.scheduler.unregisterPlugin.mock.invocationCallOrder[0]).toBeLessThan(f.jobStore.deleteAllJobs.mock.invocationCallOrder[0]);
    } else {
      expect(f.jobStore.deleteAllJobs).not.toHaveBeenCalled();
    }
  });

  it("never purges if unregistering the unloaded plugin fails", async () => {
    const f = fixture();
    f.scheduler.unregisterPlugin.mockRejectedValue(new Error("synthetic unregister failure"));
    f.emit("plugin.unloaded", { removeData: true });
    await eventually(() => expect(mocks.error).toHaveBeenCalled());
    expect(f.jobStore.deleteAllJobs).not.toHaveBeenCalled();
  });
});
