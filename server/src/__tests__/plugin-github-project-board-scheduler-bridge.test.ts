import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mocks = vi.hoisted(() => ({ readTargets: vi.fn(), coreRun: vi.fn() }));
vi.mock("../services/github-project-board-job-targets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/github-project-board-job-targets.js")>()),
  readNativeBoardJobTargets: mocks.readTargets,
}));
vi.mock("../services/plugin-github-project-scheduled.js", () => ({
  createScheduledGitHubProjectBoardService: () => ({ run: mocks.coreRun }),
}));

import { createGitHubProjectBoardSchedulerBridge } from "../services/plugin-github-project-board-scheduler-bridge.js";
import { GITHUB_PROJECT_BOARD_JOB_KEY } from "../services/github-project-schedule-grant-contract.js";
import { createPluginJobEnvelope } from "../services/plugin-job-scope.js";
import { conflict, forbidden } from "../errors.js";

const PLUGIN = "10000000-0000-4000-8000-000000000001";
const COMPANY = "20000000-0000-4000-8000-000000000002";
const COMPANY_B = "20000000-0000-4000-8000-000000000003";
const PROJECT = "30000000-0000-4000-8000-000000000003";
const JOB_ID = "40000000-0000-4000-8000-000000000004";
const RUN = "60000000-0000-4000-8000-000000000006";
const job = { id: JOB_ID, pluginId: PLUGIN, jobKey: GITHUB_PROJECT_BOARD_JOB_KEY };
const target = { companyId: COMPANY, projectId: PROJECT, jobId: JOB_ID };
const GENERIC = "Native board scheduled execution refused or held; inspect host-native receipts before retry";
const envelope = (companyId: string | null = COMPANY, trigger: "schedule" | "manual" = "schedule") =>
  createPluginJobEnvelope(GITHUB_PROJECT_BOARD_JOB_KEY, RUN, trigger, "2026-11-01T12:00:00.000Z", companyId);

/** Finds the JSON text the bridge appends to the run log inside the drizzle sql object. */
function logText(value: unknown, seen = new WeakSet<object>()): string | undefined {
  if (typeof value === "string") return value.startsWith("{\"schema\"") ? value : undefined;
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  for (const child of Object.values(value)) {
    const found = logText(child, seen);
    if (found) return found;
  }
  return undefined;
}

function fixture(options: { enabled?: boolean; savedRows?: unknown[] } = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const savedRows = options.savedRows ?? [{ id: RUN }];
  const db = {
    update: vi.fn(() => ({ set: (values: { logs: unknown }) => {
      const text = logText(values.logs);
      if (text) logs.push(JSON.parse(text));
      const where = { returning: async () => savedRows, catch: () => where };
      return { where: () => where };
    } })),
  } as unknown as Db;
  const bridge = createGitHubProjectBoardSchedulerBridge(db, vi.fn() as never, { enabled: options.enabled ?? true });
  const run = (value = envelope(), isCurrent: () => boolean = () => true) => bridge.run(job, value, 10_000, isCurrent);
  return { bridge, db, logs, run };
}

beforeEach(() => {
  mocks.readTargets.mockReset().mockResolvedValue({ job: { id: JOB_ID }, targets: [target], excluded: [] });
  mocks.coreRun.mockReset().mockResolvedValue({ status: "verified", batchVerified: true, complete: true, created: 1, reused: 0,
    preservedExisting: 0, progress: { snapshotDigest: "d", verifiedForSnapshot: 1 } });
});

describe("scheduler bridge refusals that reach the run log", () => {
  const reasonCases: Array<[string, () => void, number, string]> = [
    ["no ready plugin or exact active board job",
      () => mocks.readTargets.mockRejectedValue(forbidden("Ready native GitHub plugin and exact active board job required")),
      403, "Ready native GitHub plugin and exact active board job required"],
    ["no authorized company (no current grant for this company)",
      () => mocks.readTargets.mockResolvedValue({ job: { id: JOB_ID }, targets: [], excluded: [] }),
      403, "Exactly one current native board grant required for this company run"],
    ["more than one grant for the company",
      () => mocks.readTargets.mockResolvedValue({ job: { id: JOB_ID }, targets: [target, { ...target, projectId: COMPANY_B }], excluded: [] }),
      403, "Exactly one current native board grant required for this company run"],
    ["a result that is held",
      () => mocks.coreRun.mockResolvedValue({ status: "held", batchVerified: false, reason: "lease-held" }),
      409, "Native board result held; inspect retained lease and receipts before retry"],
    ["a batch that is not verified",
      () => mocks.coreRun.mockResolvedValue({ status: "verified", batchVerified: false, progress: {} }),
      409, "Native board result held; inspect retained lease and receipts before retry"],
    ["a delegated authorization that changed",
      () => mocks.coreRun.mockRejectedValue(conflict("Delegated native board authorization changed")),
      409, "Delegated native board authorization changed"],
    ["an expired or missing grant at run time",
      () => mocks.coreRun.mockRejectedValue(forbidden("Current enabled board schedule grant required")),
      403, "Current enabled board schedule grant required"],
  ];
  it.each(reasonCases)("writes the static reason for %s", async (_label, arrange, httpStatus, reason) => {
    arrange();
    const { logs, run } = fixture();
    await expect(run()).rejects.toThrow(GENERIC);
    expect(logs).toEqual([{ schema: "native-github-board-scheduled-failure.v1", status: "refused", httpStatus, reason }]);
  });

  it("writes the custody-changed reason when custody is lost after the grant was read", async () => {
    let calls = 0;
    const { logs, run } = fixture();
    await expect(run(envelope(), () => ++calls === 1)).rejects.toThrow(GENERIC);
    expect(logs).toEqual([expect.objectContaining({ httpStatus: 403, reason: "Native board scheduler custody or deadline changed" })]);
    expect(mocks.coreRun).not.toHaveBeenCalled();
  });

  it("writes the publication reason when the run row changed before the summary was saved", async () => {
    const { logs, run } = fixture({ savedRows: [] });
    await expect(run()).rejects.toThrow(GENERIC);
    expect(logs.at(-1)).toMatchObject({ httpStatus: 409, reason: "Native board run changed before summary publication" });
  });

  it("never copies provider or database text into the run log or the thrown error", async () => {
    mocks.coreRun.mockRejectedValue(Object.assign(new Error("token ghp_secret leaked 8f14e45f"), { name: "DrizzleQueryError" }));
    const { logs, run } = fixture();
    const error = await run().catch((caught: Error) => caught);
    expect((error as Error).message).toBe(GENERIC);
    expect(logs).toEqual([{ schema: "native-github-board-scheduled-failure.v1", status: "refused", httpStatus: 0, reason: "unclassified Error" }]);
    expect(JSON.stringify([logs, (error as Error).message])).not.toMatch(/ghp_secret|8f14e45f/);
  });

  it("writes only the verified summary on success, with no failure record", async () => {
    const { logs, run } = fixture();
    const summary = await run();
    expect(summary).toMatchObject({ schema: "native-github-board-scheduled-batch.v1", status: "verified", batchVerified: true,
      projectId: PROJECT, created: 1 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ schema: "native-github-board-scheduled-batch.v1", status: "verified" });
    expect(mocks.coreRun).toHaveBeenCalledTimes(1);
  });
});

describe("scheduler bridge refusals before any run record is touched", () => {
  it("refuses when native scheduling is disabled", async () => {
    const { run, db } = fixture({ enabled: false });
    await expect(run()).rejects.toThrow("Native GitHub board scheduling is disabled");
    expect(db.update).not.toHaveBeenCalled();
    expect(mocks.readTargets).not.toHaveBeenCalled();
  });
  it("refuses a stopped bridge", async () => {
    const { bridge, run } = fixture();
    bridge.stop();
    await expect(run()).rejects.toThrow("Native GitHub board scheduling is disabled");
  });
  it("refuses a job that is not the native board job", async () => {
    const { bridge, db } = fixture();
    await expect(bridge.run({ ...job, jobKey: "sync.github-repository" }, envelope(), 10_000, () => true))
      .rejects.toThrow("Native board bridge refuses non-board jobs");
    expect(db.update).not.toHaveBeenCalled();
  });
  it.each([
    ["a manual trigger", () => envelope(COMPANY, "manual")],
    ["an instance run with no company", () => envelope(null)],
  ])("refuses %s", async (_label, build) => {
    const { run, db } = fixture();
    await expect(run(build() as never)).rejects.toThrow("Exact native company schedule invocation required");
    expect(db.update).not.toHaveBeenCalled();
    expect(mocks.coreRun).not.toHaveBeenCalled();
  });
  it("refuses a run that is no longer current and a non-positive timeout", async () => {
    const { run, bridge } = fixture();
    await expect(run(envelope(), () => false)).rejects.toThrow("Exact native company schedule invocation required");
    await expect(bridge.run(job, envelope(), 0, () => true)).rejects.toThrow("Exact native company schedule invocation required");
  });
  it("refuses to plan dispatch for a repository job key or a disabled bridge", async () => {
    const { bridge } = fixture();
    await expect(bridge.resolveDispatch(PLUGIN, "sync.github-repository")).rejects.toThrow("refuses non-board jobs");
    await expect(fixture({ enabled: false }).bridge.resolveDispatch(PLUGIN, GITHUB_PROJECT_BOARD_JOB_KEY))
      .rejects.toThrow("scheduling is disabled");
  });
});

describe("scheduler bridge dispatch plan", () => {
  it("authorizes exactly the companies that have a current grant, sorted", async () => {
    mocks.readTargets.mockResolvedValue({ job: { id: JOB_ID }, targets: [{ ...target, companyId: COMPANY_B }, target], excluded: [] });
    const { bridge } = fixture();
    await expect(bridge.resolveDispatch(PLUGIN, GITHUB_PROJECT_BOARD_JOB_KEY)).resolves.toEqual({ scope: "company", companyIds: [COMPANY, COMPANY_B] });
  });
  it("excludes only a company with more than one grant; the other companies still dispatch", async () => {
    mocks.readTargets.mockResolvedValue({ job: { id: JOB_ID }, excluded: [],
      targets: [target, { ...target, projectId: JOB_ID }, { ...target, companyId: COMPANY_B }] });
    await expect(fixture().bridge.resolveDispatch(PLUGIN, GITHUB_PROJECT_BOARD_JOB_KEY))
      .resolves.toEqual({ scope: "company", companyIds: [COMPANY_B] });
  });
  it("excludes a company whose grant rows were reported invalid, without stopping the others", async () => {
    mocks.readTargets.mockResolvedValue({ job: { id: JOB_ID }, targets: [target],
      excluded: [{ companyId: COMPANY_B, reason: "Native board grant metadata for this company is invalid or exceeds its bounded limits" }] });
    await expect(fixture().bridge.resolveDispatch(PLUGIN, GITHUB_PROJECT_BOARD_JOB_KEY))
      .resolves.toEqual({ scope: "company", companyIds: [COMPANY] });
  });
  it("passes the readiness refusal through when no ready plugin or active job exists", async () => {
    mocks.readTargets.mockRejectedValue(forbidden("Ready native GitHub plugin and exact active board job required"));
    await expect(fixture().bridge.resolveDispatch(PLUGIN, GITHUB_PROJECT_BOARD_JOB_KEY)).rejects.toThrow("Ready native GitHub plugin and exact active board job required");
  });
});
