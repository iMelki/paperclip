import { describe, expect, it } from "vitest";
import {
  assertExistingBoardReferenceWitness,
  existingReferenceDataSchema,
  existingReferenceKey,
  type ExistingBoardReferenceWitness,
  type ExistingReferenceData,
} from "../services/github-project-existing-reference-contract.js";
import {
  boardImportDigest,
  validateBoardImportIntent,
} from "../services/plugin-imported-issues-contract.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const PLUGIN = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const REFERENCE_A = "55555555-5555-4555-8555-555555555555";
const REFERENCE_B = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";

// Synthetic public GitHub URL shapes, matching the existing board-import fixtures.
// Only the real pure validators/hash functions run: no database, process or provider ports.
function fixture() {
  const githubIssueNodeId = "I_fixture_existing_1";
  const boardId = "PVT_fixture_board_1";
  const boardItemId = "PVTI_fixture_item_1";
  const task = {
    companyId: COMPANY, projectId: PROJECT, githubIssueNodeId,
    title: "Synthetic preserved board issue",
    sourceUrl: "https://github.com/example/fixture/issues/1",
    status: "backlog" as const, assigneeAgentId: null, assigneeUserId: null, noDispatch: true as const,
  };
  const data = {
    companyId: COMPANY, projectId: PROJECT,
    taskKey: boardImportDigest(["github-issue", COMPANY, githubIssueNodeId]),
    membershipKey: boardImportDigest(["github-board-item", COMPANY, boardId, boardItemId]),
    boardId, boardItemId, githubIssueNodeId,
    boardUrl: "https://github.com/users/example/projects/1",
    sourceUpdatedAt: "2026-10-12T19:00:00Z", task,
    fields: [{ name: "Status", value: "In progress" }, { name: "Priority", value: "P2" }],
  };
  const intentHash = boardImportDigest(["board-import-v1", data]);
  const intent = validateBoardImportIntent({ ...data, intentHash, operationId: intentHash }, COMPANY);
  const referenceData = existingReferenceDataSchema.parse({
    version: 1, companyId: intent.companyId, projectId: intent.projectId,
    boardId: intent.boardId, boardItemId: intent.boardItemId, githubIssueNodeId: intent.githubIssueNodeId,
    taskId: TASK, sourceUrl: intent.task.sourceUrl, boardUrl: intent.boardUrl,
    sourceUpdatedAt: intent.sourceUpdatedAt, fields: structuredClone(intent.fields),
    mode: "reference-existing", issueWrites: 0, agentDispatchRequests: 0,
  });
  const anotherMembership = existingReferenceDataSchema.parse({
    ...referenceData, boardId: "PVT_fixture_board_2", boardItemId: "PVTI_fixture_item_2",
    boardUrl: "https://github.com/users/example/projects/2",
  });
  const references = [
    { id: REFERENCE_A, key: existingReferenceKey(referenceData) },
    { id: REFERENCE_B, key: existingReferenceKey(anotherMembership) },
  ].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const referenceIds = references.map(reference => reference.id);
  const referenceKeys = references.map(reference => reference.key);
  const witness: ExistingBoardReferenceWitness = {
    kind: "preserved-existing-board-reference", version: 1, pluginId: PLUGIN,
    companyId: intent.companyId, projectId: intent.projectId, boardId: intent.boardId,
    boardItemId: intent.boardItemId, githubIssueNodeId: intent.githubIssueNodeId,
    taskId: TASK, sourceUrl: intent.task.sourceUrl, boardUrl: intent.boardUrl,
    operationId: intent.operationId, intentHash: intent.intentHash,
    referenceId: references[0]!.id, referenceKey: references[0]!.key,
    referenceIds, referenceKeys,
    referenceDigest: boardImportDigest(["verified-existing-reference-set-v1", referenceKeys]),
    issueWrites: 0, agentDispatchRequests: 0,
    taskState: { status: "in_progress", assigneeAgentId: OTHER, assigneeUserId: null, parentId: OTHER },
  };
  return { intent, referenceData, witness };
}

function expectIdentityRefusal(change: (witness: ExistingBoardReferenceWitness) => unknown) {
  const { intent, witness } = fixture();
  const changed = change(structuredClone(witness));
  expect(changed).not.toEqual(witness);
  expect(() => assertExistingBoardReferenceWitness(intent, changed)).toThrow(/identity mismatch/);
}

describe("existing GitHub board reference contract", () => {
  it("accepts a validated canonical intent and an exact zero-write witness without changing either", () => {
    const { intent, witness } = fixture();
    const before = structuredClone({ intent, witness });
    expect(assertExistingBoardReferenceWitness(intent, witness)).toEqual(witness);
    expect(witness.referenceKeys).toHaveLength(2);
    expect(witness.referenceKeys[0]).not.toBe(witness.referenceKeys[1]);
    expect(witness.taskState).toEqual(before.witness.taskState);
    expect({ intent, witness }).toEqual(before);
  });

  it("reconstructs key provenance independently of JSONB object and field-property order", () => {
    const { referenceData } = fixture();
    const reordered = Object.fromEntries(Object.entries(referenceData).reverse()) as ExistingReferenceData;
    reordered.fields = referenceData.fields.map(field => ({ value: field.value, name: field.name }));
    expect(reordered).toEqual(referenceData);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(referenceData));
    expect(existingReferenceKey(reordered)).toBe(existingReferenceKey(referenceData));
  });

  it("keeps field-array order and changed snapshots significant to the reference key", () => {
    const { referenceData } = fixture();
    const key = existingReferenceKey(referenceData);
    expect(existingReferenceKey({ ...referenceData, fields: [...referenceData.fields].reverse() })).not.toBe(key);
    expect(existingReferenceKey({ ...referenceData, sourceUpdatedAt: "2026-10-12T19:00:01Z" })).not.toBe(key);
  });

  it("rejects validly shaped but foreign company, project, board and GitHub item identities", () => {
    const changes: Partial<ExistingBoardReferenceWitness>[] = [
      { companyId: OTHER }, { projectId: OTHER }, { boardId: "PVT_fixture_other" },
      { boardItemId: "PVTI_fixture_other" }, { githubIssueNodeId: "I_fixture_other" },
      { boardUrl: "https://github.com/users/example/projects/2" },
    ];
    for (const change of changes) expectIdentityRefusal(witness => ({ ...witness, ...change }));
  });

  it("rejects a changed operation ID or intent hash even when the reference set still matches", () => {
    const otherDigest = boardImportDigest(["synthetic-other-operation"]);
    expectIdentityRefusal(witness => ({ ...witness, operationId: otherDigest }));
    expectIdentityRefusal(witness => ({ ...witness, intentHash: otherDigest }));
  });

  it("accepts source path case variants but rejects a different canonical GitHub issue", () => {
    const { intent, witness } = fixture();
    expect(assertExistingBoardReferenceWitness(intent, {
      ...witness, sourceUrl: "https://github.com/EXAMPLE/FIXTURE/issues/1",
    }).sourceUrl).toBe("https://github.com/EXAMPLE/FIXTURE/issues/1");
    expectIdentityRefusal(value => ({ ...value, sourceUrl: "https://github.com/example/fixture/issues/2" }));
  });

  it("refuses insecure, decorated and non-issue source URLs before accepting a witness", () => {
    const { intent, witness } = fixture();
    for (const sourceUrl of [
      "http://github.com/example/fixture/issues/1",
      "https://github.com/example/fixture/issues/1?view=1",
      "https://github.com/example/fixture/issues/1#fragment",
      "https://github.com/example/fixture/pull/1",
    ]) {
      expect(() => assertExistingBoardReferenceWitness(intent, { ...witness, sourceUrl }))
        .toThrow(/Invalid canonical GitHub issue URL/);
    }
  });

  it("requires corresponding reference ID and key cardinalities", () => {
    expectIdentityRefusal(witness => {
      const referenceKeys = witness.referenceKeys.slice(0, 1);
      return { ...witness, referenceKeys,
        referenceDigest: boardImportDigest(["verified-existing-reference-set-v1", referenceKeys]) };
    });
  });

  it("refuses duplicate reference IDs or keys rather than treating the set as verified", () => {
    expectIdentityRefusal(witness => ({ ...witness, referenceIds: [witness.referenceIds[0]!, witness.referenceIds[0]!] }));
    expectIdentityRefusal(witness => {
      const referenceKeys = [witness.referenceKeys[0]!, witness.referenceKeys[0]!];
      return { ...witness, referenceKeys,
        referenceDigest: boardImportDigest(["verified-existing-reference-set-v1", referenceKeys]) };
    });
  });

  it("requires ascending keys even when IDs, first-entry fields and the set digest are updated together", () => {
    expectIdentityRefusal(witness => {
      const referenceKeys = [...witness.referenceKeys].reverse();
      const referenceIds = [...witness.referenceIds].reverse();
      return { ...witness, referenceKeys, referenceIds,
        referenceId: referenceIds[0]!, referenceKey: referenceKeys[0]!,
        referenceDigest: boardImportDigest(["verified-existing-reference-set-v1", referenceKeys]) };
    });
  });

  it("requires the leading reference ID and key to agree with the verified arrays", () => {
    expectIdentityRefusal(witness => ({ ...witness, referenceId: witness.referenceIds[1]! }));
    expectIdentityRefusal(witness => ({ ...witness, referenceKey: witness.referenceKeys[1]! }));
  });

  it("rejects an independently tampered reference-set digest", () => {
    expectIdentityRefusal(witness => ({ ...witness,
      referenceDigest: boardImportDigest(["synthetic-wrong-reference-set", witness.referenceKeys]) }));
  });

  it("rejects any witness that claims issue writes or agent dispatch", () => {
    const { intent, witness } = fixture();
    for (const change of [{ issueWrites: 1 }, { agentDispatchRequests: 1 }]) {
      expect(() => assertExistingBoardReferenceWitness(intent, { ...witness, ...change }))
        .toThrow(/Invalid existing board reference witness/);
    }
  });

  it("enforces strict bounded witness and reference-data schemas", () => {
    const { intent, witness, referenceData } = fixture();
    for (const change of [
      { extra: true }, { pluginId: "not-a-uuid" }, { boardItemId: "PVTI invalid" },
      { referenceKeys: [] }, { referenceKeys: ["not-a-digest"] },
      { taskState: { ...witness.taskState, extra: true } },
    ]) {
      expect(() => assertExistingBoardReferenceWitness(intent, { ...witness, ...change }))
        .toThrow(/Invalid existing board reference witness/);
    }
    for (const change of [
      { mode: "create-new" }, { issueWrites: 1 }, { agentDispatchRequests: 1 },
      { extra: true }, { fields: [{ name: "Status", value: "Ready", extra: true }] },
    ]) expect(existingReferenceDataSchema.safeParse({ ...referenceData, ...change }).success).toBe(false);
  });
});
