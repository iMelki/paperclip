import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  getCompanyCoordinationTasks,
  getIssueCoordination,
  ISSUE_COORDINATION_INTENT_LIMIT,
  ISSUE_COORDINATION_LEASE_LIMIT,
  ISSUE_COORDINATION_PARTICIPATION_LIMIT,
  ISSUE_COORDINATION_WORK_UNIT_LIMIT,
  resolveCoordinationCanonicalKey,
} from "./coordination.js";

const canonicalSchema = JSON.parse(readFileSync(
  new URL("../__tests__/contracts/task-coordination.v1.schema.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

interface FakePageObservation {
  table: string;
  orderByCount: number;
  limit: number | undefined;
  offset: number;
}

function fakeCoordinationDb(
  rowsByTable: Record<string, unknown[][]>,
  pageObservations: FakePageObservation[] = [],
  queryObservations: FakePageObservation[] = [],
): Db {
  const queues = new Map(Object.entries(rowsByTable).map(([table, rows]) => [table, [...rows]]));
  return {
    select: () => ({
      from: (table: unknown) => {
        const tableName = getTableName(table as never);
        return {
          where: () => {
            const rows = queues.get(tableName)?.shift() ?? [];
            let orderByCount = 0;
            let limit: number | undefined;
            let offset = 0;
            let observed = false;
            const query: Record<string, unknown> = {};
            const materialize = () => {
              if (!observed) {
                queryObservations.push({ table: tableName, orderByCount, limit, offset });
                observed = true;
              }
              const end = limit === undefined ? undefined : offset + limit;
              return Promise.resolve(rows.slice(offset, end));
            };
            query.orderBy = (...args: unknown[]) => {
              orderByCount = args.length;
              return query;
            };
            query.limit = (value: number) => {
              limit = value;
              return query;
            };
            query.offset = (value: number) => {
              offset = value;
              pageObservations.push({ table: tableName, orderByCount, limit, offset });
              return query;
            };
            query.then = (
              resolve: (value: unknown[]) => unknown,
              reject: (reason: unknown) => unknown,
            ) => materialize().then(resolve, reject);
            return query;
          },
        };
      },
    }),
  } as unknown as Db;
}

describe("coordination service canonical contract", () => {
  it("emits a schema-valid degraded view without inventing repository or process evidence", async () => {
    const rootIssueId = "22222222-2222-4222-8222-222222222222";
    const childIssueId = "33333333-3333-4333-8333-333333333333";
    const companyId = "11111111-1111-4111-8111-111111111111";
    const observedAt = new Date(Date.now() - 31 * 60 * 1000);
    const createdAt = new Date(observedAt.getTime() - 60_000);
    const issueUpdatedAt = new Date();

    const db = fakeCoordinationDb({
      issues: [
        [{
          id: rootIssueId,
          companyId,
          identifier: "PAP-200",
          issueNumber: 200,
          originKind: "manual",
          originId: null,
          status: "in_progress",
          assigneeAgentId: "agent-1",
          createdAt,
          updatedAt: issueUpdatedAt,
        }],
        [{
          id: childIssueId,
          companyId,
          status: "in_progress",
          assigneeAgentId: "agent-2",
          description: "This prose is not a typed acceptance-criteria list.",
        }],
      ],
      task_participations: [[
        {
          id: "participation-1",
          companyId,
          issueId: childIssueId,
          agentInstanceId: "44444444-4444-4444-8444-444444444444",
          runtime: "codex_local",
          role: "worker",
          mode: "mutate",
          enforcementMode: "observe",
          runId: "run-1",
          sessionId: null,
          currentAction: "testing",
          progressNote: null,
          blocker: null,
          nextAction: "review",
          retryState: null,
          startedAt: createdAt,
          lastSeenAt: observedAt,
          endedAt: null,
        },
        {
          id: "participation-ended",
          companyId,
          issueId: childIssueId,
          agentInstanceId: "88888888-8888-4888-8888-888888888888",
          runtime: "codex_local",
          role: "worker",
          mode: "mutate",
          enforcementMode: "observe",
          runId: "run-ended",
          sessionId: null,
          currentAction: null,
          progressNote: null,
          blocker: null,
          nextAction: null,
          retryState: null,
          startedAt: createdAt,
          lastSeenAt: issueUpdatedAt,
          endedAt: issueUpdatedAt,
        },
      ]],
      mutation_leases: [[{
        id: "55555555-5555-4555-8555-555555555555",
        companyId,
        issueId: childIssueId,
        status: "active",
        generation: 3,
        scopeRepositories: ["iMelki/paperclip"],
        scopePaths: ["server/src/services/coordination.ts"],
        expiresAt: new Date(Date.now() + 60_000),
        releasedAt: null,
      }]],
      control_intents: [[]],
      agent_instances: [[
        {
          id: "44444444-4444-4444-8444-444444444444",
          companyId,
          agentId: "agent-active",
          status: "active",
          hostNodeId: "66666666-6666-4666-8666-666666666666",
          metadata: {
            repository: "iMelki/paperclip",
            branch: "dev",
            dirty: false,
            remoteUrl: "https://token-user:token-secret@github.com/iMelki/paperclip.git?access_token=secret#credential",
          },
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          companyId,
          agentId: "agent-ended",
          status: "active",
          hostNodeId: "66666666-6666-4666-8666-666666666666",
          metadata: {
            repository: "iMelki/paperclip",
            branch: "dev",
            dirty: false,
            nativePath: "C:\\private\\ended-worktree",
          },
        },
      ]],
      host_nodes: [[{
        id: "66666666-6666-4666-8666-666666666666",
        companyId,
        hostId: "host-1",
        hostname: "workstation",
        os: "windows",
        runtime: "codex",
        reachableAddresses: ["127.0.0.1"],
        environment: "local",
      }]],
    });

    const resource = await getIssueCoordination(db, rootIssueId);
    expect(resource?.companyId).toBe(companyId);
    const syntheticNumber = BigInt(
      `0x${companyId.replaceAll("-", "")}${rootIssueId.replaceAll("-", "")}`,
    ).toString(10);
    expect(resource?.view.task.canonicalKey).toBe(`github:unlinked/paperclip#${syntheticNumber}`);
    expect(resource?.view.task.generation).toBe(3);
    expect(resource?.view.workUnits[0]?.acceptanceCriteria).toEqual([]);
    expect(resource?.view.participants[0]?.runtime).toBe("codex-desktop");
    expect(resource?.view.placements).toEqual([expect.objectContaining({
      hostId: "host-1",
      repository: "iMelki/paperclip",
      remoteUrl: "https://github.com/iMelki/paperclip.git",
      branch: "dev",
      dirty: false,
    })]);
    expect(JSON.stringify(resource?.view.placements)).not.toContain("token-secret");
    expect(JSON.stringify(resource?.view.placements)).not.toContain("access_token");
    expect(resource?.placementViewerAgentIds).toEqual(expect.arrayContaining([
      "agent-1",
      "agent-2",
      "agent-active",
    ]));
    expect(resource?.placementViewerAgentIds).not.toContain("agent-ended");
    expect(resource?.view.health).not.toHaveProperty("processEvidence");
    expect(resource?.view.health).not.toHaveProperty("outputEvidence");
    expect(resource?.view.health.status).toBe("stale");
    expect(resource?.view.health.freshnessTimestamp).toBe(observedAt.toISOString());
    expect(resource?.view.controls.permittedIntents).toEqual([]);
    expect(resource?.view.provenance.reconciliationDrift).toBe(true);
    expect(resource?.view.provenance.driftDetails).toContain(
      "Task status and accountable lead are Paperclip issue projections; GitHub Issues/Projects authority was not reconciled for this view.",
    );

    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(canonicalSchema);
    expect(validate(resource?.view), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("excludes expired or released leases and withholds ambiguous current mutation scope", async () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const rootIssueId = "22222222-2222-4222-8222-222222222222";
    const expiredChildId = "33333333-3333-4333-8333-333333333333";
    const ambiguousChildId = "44444444-4444-4444-8444-444444444444";
    const uniqueChildId = "55555555-5555-4555-8555-555555555555";
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);
    const past = new Date(now.getTime() - 60_000);
    const leaseRows = [
      {
        id: "60000000-0000-4000-8000-000000000001",
        companyId,
        issueId: expiredChildId,
        status: "active",
        generation: 9,
        scopeRepositories: ["stale/repository"],
        scopePaths: ["C:\\stale\\expired-scope"],
        expiresAt: past,
        releasedAt: null,
      },
      {
        id: "60000000-0000-4000-8000-000000000002",
        companyId,
        issueId: expiredChildId,
        status: "active",
        generation: 8,
        scopeRepositories: ["released/repository"],
        scopePaths: ["C:\\stale\\released-scope"],
        expiresAt: future,
        releasedAt: now,
      },
      {
        id: "60000000-0000-4000-8000-000000000003",
        companyId,
        issueId: ambiguousChildId,
        status: "active",
        generation: 3,
        scopeRepositories: ["ambiguous/first"],
        scopePaths: ["server/first"],
        expiresAt: future,
        releasedAt: null,
      },
      {
        id: "60000000-0000-4000-8000-000000000004",
        companyId,
        issueId: ambiguousChildId,
        status: "active",
        generation: 4,
        scopeRepositories: ["ambiguous/second"],
        scopePaths: ["server/second"],
        expiresAt: future,
        releasedAt: null,
      },
      {
        id: "60000000-0000-4000-8000-000000000005",
        companyId,
        issueId: uniqueChildId,
        status: "active",
        generation: 5,
        scopeRepositories: ["iMelki/paperclip"],
        scopePaths: ["server/src/routes/coordination.ts"],
        expiresAt: future,
        releasedAt: null,
      },
    ];
    const createLeaseDb = (leasesForRun: typeof leaseRows) => fakeCoordinationDb({
      issues: [
        [{
          id: rootIssueId,
          companyId,
          identifier: "PAP-28",
          originKind: "manual",
          originId: null,
          status: "in_progress",
          assigneeAgentId: "agent-lead",
          createdAt: past,
          updatedAt: now,
        }],
        [
          { id: expiredChildId, companyId, status: "in_progress", assigneeAgentId: "agent-1" },
          { id: ambiguousChildId, companyId, status: "in_progress", assigneeAgentId: "agent-2" },
          { id: uniqueChildId, companyId, status: "in_progress", assigneeAgentId: "agent-3" },
        ],
      ],
      task_participations: [[]],
      mutation_leases: [leasesForRun],
      control_intents: [[]],
    });

    const forward = await getIssueCoordination(createLeaseDb(leaseRows), rootIssueId, companyId);
    const reverse = await getIssueCoordination(createLeaseDb([...leaseRows].reverse()), rootIssueId, companyId);

    expect(forward?.view.task.generation).toBe(9);
    expect(forward?.view.workUnits.map((workUnit) => workUnit.mutationScope)).toEqual([
      { repositories: [], paths: [] },
      { repositories: [], paths: [] },
      { repositories: ["iMelki/paperclip"], paths: ["server/src/routes/coordination.ts"] },
    ]);
    expect(reverse?.view.workUnits.map((workUnit) => workUnit.mutationScope)).toEqual(
      forward?.view.workUnits.map((workUnit) => workUnit.mutationScope),
    );
    expect(forward?.view.provenance.driftDetails).toEqual(expect.arrayContaining([
      "2 status-active mutation lease(s) were expired, released, or invalid and were excluded from current mutation authority.",
      `Issue '${ambiguousChildId}' has 2 concurrent unexpired active mutation leases; mutation scope is withheld because lease authority is ambiguous.`,
    ]));
    const serialized = JSON.stringify(forward?.view);
    expect(serialized).not.toContain("expired-scope");
    expect(serialized).not.toContain("released-scope");
    expect(serialized).not.toContain("ambiguous/first");
    expect(serialized).not.toContain("ambiguous/second");
  });

  it("keeps synthetic canonical keys unique across companies and rejects untrusted GitHub-looking identifiers", () => {
    const issueId = "22222222-2222-4222-8222-222222222222";
    const firstDrift: string[] = [];
    const secondDrift: string[] = [];
    const spoofDrift: string[] = [];

    const firstKey = resolveCoordinationCanonicalKey({
      companyId: "11111111-1111-4111-8111-111111111111",
      id: issueId,
      identifier: "PAP-200",
      originKind: "manual",
      originId: null,
    }, firstDrift);
    const secondKey = resolveCoordinationCanonicalKey({
      companyId: "99999999-9999-4999-8999-999999999999",
      id: issueId,
      identifier: "PAP-200",
      originKind: "manual",
      originId: null,
    }, secondDrift);
    const spoofKey = resolveCoordinationCanonicalKey({
      companyId: "11111111-1111-4111-8111-111111111111",
      id: "77777777-7777-4777-8777-777777777777",
      identifier: "github:iMelki/paperclip#200",
      originKind: "manual",
      originId: null,
    }, spoofDrift);

    expect(firstKey).not.toBe(secondKey);
    expect(spoofKey).not.toBe("github:iMelki/paperclip#200");
    expect(firstDrift).not.toEqual([]);
    expect(secondDrift).not.toEqual([]);
    expect(spoofDrift).not.toEqual([]);
  });

  it("keeps the listed company-scoped root without a racy per-root detail reload", async () => {
    const rootIssueId = "22222222-2222-4222-8222-222222222222";
    const listedCompanyId = "11111111-1111-4111-8111-111111111111";
    const now = new Date();
    const queryObservations: FakePageObservation[] = [];
    const db = fakeCoordinationDb({
      issues: [
        [{
          id: rootIssueId,
          companyId: listedCompanyId,
          identifier: "PAP-200",
          issueNumber: 200,
          originKind: "manual",
          originId: null,
          status: "in_progress",
          assigneeAgentId: null,
          createdAt: now,
          updatedAt: now,
        }],
        [],
      ],
      task_participations: [[]],
      mutation_leases: [[]],
      control_intents: [[]],
    }, [], queryObservations);

    const result = await getCompanyCoordinationTasks(db, listedCompanyId);
    expect(result).toHaveLength(1);
    expect(result[0]?.task.paperclipParentIssueId).toBe(rootIssueId);
    expect(queryObservations.filter((entry) => entry.table === "issues")).toHaveLength(2);
  });

  it("bounds direct collection callers and keeps deterministic page order", async () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const firstId = "11111111-1111-4111-8111-111111111112";
    const selectedId = "22222222-2222-4222-8222-222222222222";
    const thirdId = "33333333-3333-4333-8333-333333333333";
    const now = new Date();
    const pageObservations: FakePageObservation[] = [];
    const selectedRoot = {
      id: selectedId,
      companyId,
      identifier: "PAP-200",
      originKind: "manual",
      originId: null,
      status: "in_progress",
      assigneeAgentId: null,
      createdAt: now,
      updatedAt: now,
    };
    const db = fakeCoordinationDb({
      issues: [
        [
          { ...selectedRoot, id: firstId, updatedAt: new Date(now.getTime() + 2_000) },
          { ...selectedRoot, id: selectedId, updatedAt: new Date(now.getTime() + 1_000) },
          { ...selectedRoot, id: thirdId, updatedAt: now },
        ],
        [],
      ],
      task_participations: [[]],
      mutation_leases: [[]],
      control_intents: [[]],
    }, pageObservations);

    const result = await getCompanyCoordinationTasks(db, companyId, { limit: 1, offset: 1 });

    expect(result).toHaveLength(1);
    expect(result[0]?.task.paperclipParentIssueId).toBe(selectedId);
    expect(pageObservations).toEqual([{
      table: "issues",
      orderByCount: 2,
      limit: 1,
      offset: 1,
    }]);
  });

  it("uses a fixed query set and fails closed when a root exceeds nested projection bounds", async () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const rootIssueId = "22222222-2222-4222-8222-222222222222";
    const now = new Date();
    const childId = (index: number) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
    const participationId = (index: number) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`;
    const leaseId = (index: number) => `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;
    const intentId = (index: number) => `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`;
    const instanceId = (index: number) => `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;
    const hostNodeId = "88888888-8888-4888-8888-888888888888";
    const queryObservations: FakePageObservation[] = [];
    const children = Array.from({ length: ISSUE_COORDINATION_WORK_UNIT_LIMIT + 1 }, (_, index) => ({
      id: childId(index),
      companyId,
      parentId: rootIssueId,
      status: "in_progress",
      assigneeAgentId: null,
      updatedAt: now,
    }));
    const participations = Array.from({ length: ISSUE_COORDINATION_PARTICIPATION_LIMIT + 1 }, (_, index) => ({
      id: participationId(index),
      companyId,
      issueId: index === 0 ? rootIssueId : childId(index % ISSUE_COORDINATION_WORK_UNIT_LIMIT),
      agentInstanceId: instanceId(index),
      runtime: "codex_local",
      role: "worker",
      mode: "read",
      enforcementMode: "observe",
      runId: null,
      sessionId: null,
      currentAction: null,
      progressNote: null,
      blocker: null,
      nextAction: null,
      retryState: null,
      startedAt: now,
      lastSeenAt: now,
      endedAt: null,
    }));
    const leases = Array.from({ length: ISSUE_COORDINATION_LEASE_LIMIT + 1 }, (_, index) => ({
      id: leaseId(index),
      companyId,
      issueId: childId(index % ISSUE_COORDINATION_WORK_UNIT_LIMIT),
      status: "active",
      generation: index + 1,
      scopeRepositories: ["must/not/leak-as-authority"],
      scopePaths: ["must/not/leak-as-authority"],
      expiresAt: new Date(now.getTime() + 60_000),
      releasedAt: null,
      updatedAt: now,
    }));
    const intents = Array.from({ length: ISSUE_COORDINATION_INTENT_LIMIT + 1 }, (_, index) => ({
      id: intentId(index),
      companyId,
      rootIssueId,
      targetWorkUnitId: null,
      requestedBy: "operator",
      intentType: "pause",
      status: "pending",
      receipt: null,
      executedAt: null,
      createdAt: now,
    }));
    const db = fakeCoordinationDb({
      issues: [[{
        id: rootIssueId,
        companyId,
        identifier: "PAP-HIGH-FANOUT",
        issueNumber: 999,
        originKind: "manual",
        originId: null,
        status: "in_progress",
        assigneeAgentId: null,
        createdAt: now,
        updatedAt: now,
      }], children],
      task_participations: [participations],
      mutation_leases: [leases],
      control_intents: [intents],
      agent_instances: [Array.from({ length: ISSUE_COORDINATION_PARTICIPATION_LIMIT }, (_, index) => ({
        id: instanceId(index),
        companyId,
        agentId: `agent-active-${index}`,
        status: "active",
        hostNodeId,
        metadata: { repository: "iMelki/paperclip", branch: "dev", dirty: false },
      }))],
      host_nodes: [[{
        id: hostNodeId,
        companyId,
        hostId: "high-fanout-host",
        hostname: "workstation",
        os: "windows",
        runtime: "codex",
      }]],
    }, [], queryObservations);

    const result = await getCompanyCoordinationTasks(db, companyId, { limit: 100, offset: 0 });

    expect(queryObservations.map((entry) => entry.table)).toEqual([
      "issues",
      "issues",
      "task_participations",
      "mutation_leases",
      "control_intents",
      "agent_instances",
      "host_nodes",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.workUnits).toHaveLength(ISSUE_COORDINATION_WORK_UNIT_LIMIT);
    expect(result[0]?.participants).toHaveLength(ISSUE_COORDINATION_PARTICIPATION_LIMIT);
    expect(result[0]?.placements).toHaveLength(ISSUE_COORDINATION_PARTICIPATION_LIMIT);
    expect(result[0]?.controls.pendingIntents).toHaveLength(ISSUE_COORDINATION_INTENT_LIMIT);
    expect(result[0]?.workUnits.every((workUnit) => (
      workUnit.mutationScope.repositories.length === 0 && workUnit.mutationScope.paths.length === 0
    ))).toBe(true);
    expect(result[0]?.provenance.driftDetails).toEqual(expect.arrayContaining([
      expect.stringContaining("'workUnits' was truncated"),
      expect.stringContaining("'participants' was truncated"),
      expect.stringContaining("'mutationLeases' was truncated"),
      expect.stringContaining("'controlIntents' was truncated"),
      "Mutation-lease projection is incomplete; all mutation scope is withheld until authoritative lease reconciliation completes.",
    ]));
  });

  it("withholds every mutation scope when work-unit truncation makes task-wide lease authority incomplete", async () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const rootIssueId = "22222222-2222-4222-8222-222222222222";
    const now = new Date();
    const childId = (index: number) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
    const children = Array.from({ length: ISSUE_COORDINATION_WORK_UNIT_LIMIT + 1 }, (_, index) => ({
      id: childId(index),
      companyId,
      parentId: rootIssueId,
      status: "in_progress",
      assigneeAgentId: null,
      updatedAt: new Date(now.getTime() - index),
    }));
    const db = fakeCoordinationDb({
      issues: [[{
        id: rootIssueId,
        companyId,
        identifier: "PAP-TRUNCATED-WORK-UNITS",
        issueNumber: 1_000,
        originKind: "manual",
        originId: null,
        status: "in_progress",
        assigneeAgentId: null,
        createdAt: now,
        updatedAt: now,
      }], children],
      task_participations: [[]],
      // A real bounded issue-id query cannot retrieve the omitted child's lease.
      // Keeping the returned lease set below its own cap proves that work-unit
      // truncation alone must make task-wide lease authority incomplete.
      mutation_leases: [[{
        id: "55555555-5555-4555-8555-555555555555",
        companyId,
        issueId: childId(0),
        status: "active",
        generation: 1,
        scopeRepositories: ["must/not/leak-as-authority"],
        scopePaths: ["must/not/leak-as-authority"],
        expiresAt: new Date(now.getTime() + 60_000),
        releasedAt: null,
        updatedAt: now,
      }]],
      control_intents: [[]],
    });

    const [result] = await getCompanyCoordinationTasks(db, companyId, { limit: 100, offset: 0 });

    expect(result?.workUnits).toHaveLength(ISSUE_COORDINATION_WORK_UNIT_LIMIT);
    expect(result?.workUnits.every((workUnit) => (
      workUnit.mutationScope.repositories.length === 0 && workUnit.mutationScope.paths.length === 0
    ))).toBe(true);
    expect(result?.provenance.driftDetails).toEqual(expect.arrayContaining([
      expect.stringContaining("'workUnits' was truncated"),
      "Mutation-lease projection is incomplete; all mutation scope is withheld until authoritative lease reconciliation completes.",
    ]));
    expect(result?.provenance.driftDetails).not.toEqual(expect.arrayContaining([
      expect.stringContaining("'mutationLeases' was truncated"),
    ]));
  });

  it("defaults and caps direct collection page options before querying", async () => {
    const companyId = "11111111-1111-4111-8111-111111111111";
    const pageObservations: FakePageObservation[] = [];
    const db = fakeCoordinationDb({ issues: [[], [], []] }, pageObservations);

    await getCompanyCoordinationTasks(db, companyId);
    await getCompanyCoordinationTasks(db, companyId, { limit: 500, offset: -1 });
    await getCompanyCoordinationTasks(db, companyId, { limit: 25, offset: 7 });
    await getCompanyCoordinationTasks(db, companyId, { limit: 25, offset: 50_000 });

    expect(pageObservations.map(({ orderByCount, limit, offset }) => ({
      orderByCount,
      limit,
      offset,
    }))).toEqual([
      { orderByCount: 2, limit: 50, offset: 0 },
      { orderByCount: 2, limit: 100, offset: 0 },
      { orderByCount: 2, limit: 25, offset: 7 },
      { orderByCount: 2, limit: 25, offset: 10_000 },
    ]);
  });
});
