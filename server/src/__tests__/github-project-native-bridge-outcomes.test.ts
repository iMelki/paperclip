import { describe, expect, it, vi } from "vitest";

const { run, targets } = vi.hoisted(() => ({ run: vi.fn(), targets: vi.fn() }));
vi.mock("../services/plugin-github-project-scheduled.js", () => ({
  createScheduledGitHubProjectBoardService: () => ({ run }),
}));
vi.mock("../services/github-project-board-job-targets.js", () => ({
  isNativeGitHubBoardJobKey: (key: string) => key === "sync.github-project-board",
  readNativeBoardJobTargets: targets,
}));

import { createGitHubProjectBoardSchedulerBridge } from "../services/plugin-github-project-board-scheduler-bridge.js";

describe("native GitHub board scheduled outcomes", () => {
  it.each([
    { status: "held", batchVerified: false, progress: {} },
    { status: "verified", batchVerified: false, progress: {} },
    { status: "verified", batchVerified: true, progress: null },
  ])("rejects a resolved but unverified scheduled result %#", async result => {
    const companyId = "00000000-0000-4000-8000-000000000002";
    const job = { id: "job", pluginId: "plugin", jobKey: "sync.github-project-board" };
    const envelope = { companyId, job: { runId: "run", jobKey: job.jobKey, trigger: "schedule", companyId } };
    targets.mockResolvedValue({ targets: [{ companyId, projectId: "project", jobId: job.id, jobRunId: "run" }] });
    run.mockResolvedValue(result);
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const bridge = createGitHubProjectBoardSchedulerBridge({ update } as never, vi.fn(), { enabled: true });
    await expect(bridge.run(job as never, envelope as never, 5_000, () => true)).rejects.toThrow("refused or held");
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(Object.keys(set.mock.calls[0][0])).toEqual(["logs"]);
  });
});
