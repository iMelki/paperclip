import { describe, expect, it, vi } from "vitest";
import { dispatchPluginJobBatch, type PluginJobBatchPorts } from "../services/plugin-job-batch.js";

const runs = [{ id: "run-a", companyId: "company-a" }, { id: "run-b", companyId: "company-b" }];
const input = { jobKey: "sync", trigger: "schedule" as const, scheduledAt: "2026-10-23T00:00:00Z", timeoutMs: 100 };
function fixture() {
  let time = 0;
  let current = true;
  let running = true;
  const ports: PluginJobBatchPorts = {
    now: () => time, isCurrent: () => current, isWorkerRunning: () => running,
    isCompanyAuthorized: vi.fn(async () => true), markRunning: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined), call: vi.fn(async () => undefined),
    isTimeout: (error) => error === "timeout",
  };
  return { ports, advance: (value: number) => { time += value; }, revoke: () => { current = false; },
    stop: () => { running = false; } };
}
describe("sequential company job batch", () => {
  it("awaits each execution with distinct runId and exact envelope", async () => {
    const { ports, advance } = fixture();
    const events: string[] = [];
    ports.call = vi.fn(async (params) => {
      events.push(`start:${params.companyId}`);
      await Promise.resolve(); advance(10); events.push(`end:${params.companyId}`);
    });
    await dispatchPluginJobBatch(input, runs, ports);
    expect(events).toEqual(["start:company-a", "end:company-a", "start:company-b", "end:company-b"]);
    expect(ports.call).toHaveBeenNthCalledWith(1, expect.objectContaining({ companyId: "company-a",
      job: expect.objectContaining({ runId: "run-a", companyId: "company-a" }) }), 100);
    expect(ports.call).toHaveBeenNthCalledWith(2, expect.objectContaining({ companyId: "company-b",
      job: expect.objectContaining({ runId: "run-b", companyId: "company-b" }) }), 90);
  });
  it("records a company failure and still attempts the other authorized company", async () => {
    const { ports } = fixture();
    ports.call = vi.fn(async (params) => { if (params.companyId === "company-a") throw new Error("synthetic failure"); });
    await dispatchPluginJobBatch(input, runs, ports);
    expect(ports.call).toHaveBeenCalledTimes(2);
    expect(ports.completeRun).toHaveBeenNthCalledWith(1, "run-a", expect.objectContaining({ status: "failed" }));
    expect(ports.completeRun).toHaveBeenNthCalledWith(2, "run-b", expect.objectContaining({ status: "succeeded" }));
  });
  it("refuses a revoked company without changing its target", async () => {
    const { ports } = fixture();
    ports.isCompanyAuthorized = vi.fn(async (id) => id === "company-b");
    await dispatchPluginJobBatch(input, runs, ports);
    expect(ports.call).toHaveBeenCalledTimes(1);
    expect(ports.call).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-b" }), expect.any(Number));
    expect(ports.completeRun).toHaveBeenNthCalledWith(1, "run-a", expect.objectContaining({ status: "failed" }));
  });
  it("defers the remaining company after timeout instead of overlapping uncertain work", async () => {
    const { ports } = fixture();
    ports.call = vi.fn(async () => { throw "timeout"; });
    await dispatchPluginJobBatch(input, runs, ports);
    expect(ports.call).toHaveBeenCalledTimes(1);
    expect(ports.completeRun).toHaveBeenNthCalledWith(2, "run-b", expect.objectContaining({ status: "cancelled",
      error: expect.stringContaining("timed out") }));
  });
  it("does not dispatch after its total RPC budget is spent", async () => {
    const { ports, advance } = fixture();
    ports.call = vi.fn(async () => { advance(100); });
    await dispatchPluginJobBatch(input, runs, ports);
    expect(ports.call).toHaveBeenCalledTimes(1);
    expect(ports.completeRun).toHaveBeenNthCalledWith(2, "run-b", expect.objectContaining({ status: "cancelled" }));
  });
  it("does not resume fan-out or overwrite cancellation after owner revocation", async () => {
    const { ports, revoke } = fixture();
    ports.call = vi.fn(async () => { revoke(); });
    await dispatchPluginJobBatch(input, runs, ports);
    expect(ports.call).toHaveBeenCalledTimes(1);
    expect(ports.completeRun).not.toHaveBeenCalled();
  });
  it("does not retry an unknown completion write", async () => {
    const { ports } = fixture();
    ports.completeRun = vi.fn(async () => { throw new Error("completion transport lost"); });
    await expect(dispatchPluginJobBatch(input, runs, ports)).rejects.toThrow("completion transport lost");
    expect(ports.completeRun).toHaveBeenCalledTimes(1);
    expect(ports.call).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch while worker is unavailable", async () => {
    const { ports, stop } = fixture(); stop();
    await dispatchPluginJobBatch(input, runs, ports);
    expect(ports.call).not.toHaveBeenCalled();
    expect(ports.completeRun).toHaveBeenCalledTimes(2);
  });
});
