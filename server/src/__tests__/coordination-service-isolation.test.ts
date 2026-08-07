import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentInstances,
  companies,
  controlIntents,
  createDb,
  hostNodes,
  issues,
  mutationLeases,
  taskParticipations,
} from "@paperclipai/db";
import {
  EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getIssueCoordination } from "../services/coordination.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres coordination isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("coordination service company isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-coordination-isolation-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(controlIntents);
    await db.delete(mutationLeases);
    await db.delete(taskParticipations);
    await db.delete(agentInstances);
    await db.delete(hostNodes);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("excludes cross-company rows even when they reference the requested issue id", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const rootIssueA = randomUUID();
    const rootIssueB = randomUUID();
    const hostA = randomUUID();
    const hostB = randomUUID();
    const instanceA = randomUUID();
    const instanceB = randomUUID();
    const participationA = randomUUID();
    const poisonedParticipationB = randomUUID();
    const intentA = randomUUID();
    const poisonedIntentB = randomUUID();

    await db.insert(companies).values([
      {
        id: companyA,
        name: "Coordination Company A",
        issuePrefix: `A${companyA.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: companyB,
        name: "Coordination Company B",
        issuePrefix: `B${companyB.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(issues).values([
      {
        id: rootIssueA,
        companyId: companyA,
        title: "Company A root",
        status: "in_progress",
        issueNumber: 101,
        identifier: `A-${rootIssueA.slice(0, 8)}`,
      },
      {
        id: rootIssueB,
        companyId: companyB,
        title: "Company B root",
        status: "in_progress",
        issueNumber: 202,
        identifier: `B-${rootIssueB.slice(0, 8)}`,
      },
    ]);
    await db.insert(hostNodes).values([
      {
        id: hostA,
        companyId: companyA,
        hostId: `host-${randomUUID()}`,
        hostname: "company-a-private-host",
        os: "windows",
        runtime: "codex",
      },
      {
        id: hostB,
        companyId: companyB,
        hostId: `host-${randomUUID()}`,
        hostname: "company-b-secret-host",
        os: "windows",
        runtime: "codex",
      },
    ]);
    await db.insert(agentInstances).values([
      {
        id: instanceA,
        companyId: companyA,
        agentId: "agent-a",
        runtime: "codex-local",
        hostNodeId: hostA,
        metadata: {
          repository: "iMelki/paperclip",
          branch: "dev",
          dirty: false,
          nativePath: "C:\\company-a\\paperclip",
        },
      },
      {
        id: instanceB,
        companyId: companyB,
        agentId: "agent-b-secret",
        runtime: "codex-local",
        hostNodeId: hostB,
        metadata: {
          repository: "secret/repository",
          branch: "secret-branch",
          dirty: true,
          nativePath: "C:\\company-b-secret\\paperclip",
        },
      },
    ]);
    await db.insert(taskParticipations).values([
      {
        id: participationA,
        companyId: companyA,
        issueId: rootIssueA,
        agentInstanceId: instanceA,
        runtime: "codex-local",
      },
      {
        id: poisonedParticipationB,
        companyId: companyB,
        issueId: rootIssueA,
        agentInstanceId: instanceB,
        runtime: "codex-local",
        progressNote: "company-b-secret-progress",
      },
    ]);
    await db.insert(mutationLeases).values([
      {
        companyId: companyA,
        issueId: rootIssueA,
        leaseTokenHash: "a".repeat(64),
        holderAgentId: "agent-a",
        workUnitId: rootIssueA,
        scopeRepositories: ["iMelki/paperclip"],
        scopePaths: ["server/src/services/coordination.ts"],
        generation: 2,
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        companyId: companyB,
        issueId: rootIssueA,
        leaseTokenHash: "b".repeat(64),
        holderAgentId: "agent-b-secret",
        workUnitId: rootIssueA,
        scopeRepositories: ["secret/repository"],
        scopePaths: ["C:\\company-b-secret"],
        generation: 99,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await db.insert(controlIntents).values([
      {
        id: intentA,
        companyId: companyA,
        rootIssueId: rootIssueA,
        intentType: "pause",
        requestedBy: "board-a",
      },
      {
        id: poisonedIntentB,
        companyId: companyB,
        rootIssueId: rootIssueA,
        intentType: "cancel",
        requestedBy: "company-b-secret-requester",
      },
    ]);

    const resource = await getIssueCoordination(db, rootIssueA, companyA);
    expect(resource).not.toBeNull();
    expect(resource?.companyId).toBe(companyA);
    expect(resource?.view.task.generation).toBe(2);
    expect(resource?.view.participants.map((participant) => participant.id)).toEqual([participationA]);
    expect(resource?.view.placements).toHaveLength(1);
    expect(resource?.view.placements[0]).toMatchObject({
      hostname: "company-a-private-host",
      repository: "iMelki/paperclip",
      branch: "dev",
    });
    expect(resource?.view.controls.pendingIntents.map((intent) => intent.id)).toEqual([intentA]);
    expect(resource?.placementViewerAgentIds).toContain("agent-a");
    expect(resource?.placementViewerAgentIds).not.toContain("agent-b-secret");
    expect(JSON.stringify(resource)).not.toContain("company-b-secret");
    expect(JSON.stringify(resource)).not.toContain("secret/repository");
    expect(JSON.stringify(resource)).not.toContain(poisonedParticipationB);
    expect(JSON.stringify(resource)).not.toContain(poisonedIntentB);
  });
});
