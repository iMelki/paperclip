import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());
const mockQueueDurableHireNotification = vi.hoisted(() => vi.fn());
const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));
const mockBudgetServiceFactory = vi.hoisted(() => vi.fn(() => mockBudgetService));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
  queueDurableHireNotification: mockQueueDurableHireNotification,
}));

vi.mock("../services/budgets.js", () => ({
  budgetService: mockBudgetServiceFactory,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => mockSecretService),
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(
  selectResults: ApprovalRecord[][],
  updateResults: ApprovalRecord[],
  insertResults: ApprovalRecord[] = [],
) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const insertReturning = vi.fn(async () => insertResults);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  let committed = false;
  const transactionSource = { select, update, insert } as Record<string, unknown>;
  const db = { ...transactionSource } as Record<string, unknown>;
  const transaction = vi.fn(async (callback: (source: unknown) => Promise<unknown>) => {
    const result = await callback(transactionSource);
    committed = true;
    return result;
  });
  db.transaction = transaction;

  return {
    db,
    selectWhere,
    returning,
    set,
    insertValues,
    transaction,
    transactionSource,
    isCommitted: () => committed,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      status: "pending_approval",
      adapterConfig: {},
      runtimeConfig: {},
      metadata: null,
    });
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockBudgetService.upsertPolicy.mockResolvedValue({ id: "budget-1" });
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId: string, payload: Record<string, unknown>) => payload,
    );
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("enforces hire-payload preparation inside low-level create", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      status: "pending_approval",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "sk-live" },
        },
      },
      runtimeConfig: {},
      metadata: null,
    });
    const dbStub = createDbStub([], [], [createApproval("pending")]);
    const rawPayload = {
      agentId: "agent-1",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "sk-live" },
        },
      },
    };

    await approvalService(dbStub.db as any).create(
      "company-1",
      {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: "board-user",
        status: "pending",
        payload: rawPayload,
      },
      { strictMode: false },
    );

    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).toHaveBeenCalledWith(
      "company-1",
      rawPayload,
      { strictMode: false },
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      type: "hire_agent",
      payload: expect.objectContaining({
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" },
          },
        },
      }),
    }));
  });

  it("revalidates an already-redacted hire payload at low-level create", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      status: "pending_approval",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "sk-live" },
        },
      },
      runtimeConfig: {},
      metadata: null,
    });
    const dbStub = createDbStub([], [], [createApproval("pending")]);

    await approvalService(dbStub.db as any).create("company-1", {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        agentId: "agent-1",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" },
          },
        },
      },
    });

    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "sk-live" },
          },
        },
      }),
      undefined,
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" },
          },
        },
      }),
    }));
  });

  it("does not apply the hire-payload guard to non-hire create", async () => {
    const inserted = {
      ...createApproval("pending"),
      type: "request_board_approval",
      payload: { title: "Approve hosting spend" },
    };
    const dbStub = createDbStub([], [], [inserted]);

    await approvalService(dbStub.db as any).create("company-1", {
      type: "request_board_approval",
      requestedByAgentId: "requester-1",
      requestedByUserId: null,
      status: "pending",
      payload: inserted.payload,
    });

    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(dbStub.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      type: "request_board_approval",
      payload: inserted.payload,
    }));
  });

  it("enforces hire-payload preparation inside low-level resubmit", async () => {
    const existing = {
      ...createApproval("revision_requested"),
      payload: { agentId: "agent-1" },
    };
    const updated = { ...existing, status: "pending" };
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      status: "pending_approval",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "sk-live" },
        },
      },
      runtimeConfig: {},
      metadata: null,
    });
    const dbStub = createDbStub([[existing]], [updated]);

    await approvalService(dbStub.db as any).resubmit("approval-1", {
      agentId: "agent-1",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "sk-live" },
        },
      },
    });

    expect(dbStub.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "pending",
      payload: expect.objectContaining({
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" },
          },
        },
      }),
    }));
  });

  it("normalizes, restores, and re-redacts a resubmitted pending-agent payload", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      status: "pending_approval",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "persisted-secret" },
          EMPTY_API_KEY: { type: "plain", value: "" },
        },
      },
    });
    const dbStub = createDbStub([], []);
    const prepared = await approvalService(dbStub.db as any).prepareHirePayloadForPersistence(
      "company-1",
      {
        agentId: "agent-1",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" },
            EMPTY_API_KEY: { type: "plain", value: "" },
          },
        },
      },
    );

    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "persisted-secret" },
            EMPTY_API_KEY: { type: "plain", value: "" },
          },
        },
      }),
      undefined,
    );
    expect(prepared).toMatchObject({
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" },
          EMPTY_API_KEY: { type: "plain", value: "" },
        },
      },
    });
  });

  it.each([
    ["nonempty", "sk-live"],
    ["whitespace", "   "],
  ])("fails closed for a %s secret when no pending baseline exists", async (_case, value) => {
    const dbStub = createDbStub([], []);

    await expect(
      approvalService(dbStub.db as any).prepareHirePayloadForPersistence("company-1", {
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value },
          },
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_secret_baseline_required",
        path: "adapterConfig.env.OPENAI_API_KEY.value",
      },
    });
  });

  it("allows an exact-empty binding without a pending baseline", async () => {
    const dbStub = createDbStub([], []);
    const prepared = await approvalService(dbStub.db as any).prepareHirePayloadForPersistence(
      "company-1",
      {
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "" },
          },
        },
      },
    );

    expect(prepared).toMatchObject({
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "" },
        },
      },
    });
  });

  it.each([
    ["missing", null],
    ["cross-company", { id: "agent-1", companyId: "company-2", status: "pending_approval" }],
    ["not-pending", { id: "agent-1", companyId: "company-1", status: "idle" }],
  ])("rejects a %s pending-agent baseline before normalization", async (_case, pendingAgent) => {
    mockAgentService.getById.mockResolvedValue(pendingAgent);
    const dbStub = createDbStub([], []);

    await expect(
      approvalService(dbStub.db as any).prepareHirePayloadForPersistence("company-1", {
        agentId: "agent-1",
        adapterConfig: {},
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_pending_agent_mismatch",
        companyId: "company-1",
        agentId: "agent-1",
      },
    });
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: { agentId: "agent-1", budgetMonthlyCents: 1_000 },
    };
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        ...approved.payload,
        permissions: {
          canCreateAgents: false,
          canCreateSkills: true,
        },
      }),
    );
    expect(mockBudgetServiceFactory).toHaveBeenCalledWith(dbStub.transactionSource);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("restores nonempty redactions from the pending same-company agent", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        agentId: "agent-1",
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" },
          },
        },
      },
    };
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      status: "pending_approval",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "plain", value: "persisted-secret" },
        },
      },
      runtimeConfig: {},
      metadata: null,
    });
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    await approvalService(dbStub.db as any).approve("approval-1", "board", "ship it");

    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        adapterConfig: {
          env: {
            OPENAI_API_KEY: { type: "plain", value: "persisted-secret" },
          },
        },
      }),
    );
  });

  it("fails closed for a pending agent from another company", async () => {
    const approved = createApproval("approved");
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-2",
      status: "pending_approval",
      adapterConfig: {},
      runtimeConfig: {},
      metadata: null,
    });
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    await expect(
      approvalService(dbStub.db as any).approve("approval-1", "board", "ship it"),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "hire_approval_pending_agent_mismatch" },
    });
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("rolls the transaction back when pending-agent activation loses the race", async () => {
    const approved = createApproval("approved");
    mockAgentService.activatePendingApproval.mockResolvedValue({
      agent: { id: "agent-1" },
      activated: false,
    });
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    await expect(
      approvalService(dbStub.db as any).approve("approval-1", "board", "ship it"),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "hire_approval_activation_not_applied" },
    });
    expect(dbStub.isCommitted()).toBe(false);
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("notifies only after the approval transaction commits", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);
    mockNotifyHireApproved.mockImplementation(async () => {
      expect(dbStub.isCommitted()).toBe(true);
    });

    await approvalService(dbStub.db as any).approve("approval-1", "board", "ship it");

    expect(dbStub.transaction).toHaveBeenCalledTimes(1);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const restrictivePermissions = {
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    };
    const runtimeConfig = { modelProfiles: { cheap: { enabled: false, adapterConfig: {} } } };
    const approved = {
      ...createApproval("approved"),
      payload: {
        name: "New Agent",
        icon: "bot",
        runtimeConfig,
        defaultEnvironmentId: "00000000-0000-4000-8000-000000000001",
        permissions: restrictivePermissions,
        metadata: ["not", "an", "object-record"],
        adapterConfig: {
          env: {
            API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        },
      },
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
        icon: approved.payload.icon,
        runtimeConfig,
        defaultEnvironmentId: approved.payload.defaultEnvironmentId,
        permissions: restrictivePermissions,
        metadata: null,
      }),
    );
  });

  it("fails closed before creating an agent from a legacy standalone privilege escalation", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        name: "Hidden Delegation",
        role: "engineer",
        adapterType: "process",
        permissions: {
          canCreateAgents: true,
        },
      },
    };
    const dbStub = createDbStub(
      [[{ ...createApproval("pending"), payload: approved.payload }]],
      [approved],
    );

    await expect(
      approvalService(dbStub.db as any).approve("approval-1", "board", "ship it"),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "hire_approval_permission_escalation",
        path: "permissions.canCreateAgents",
      },
    });

    expect(dbStub.isCommitted()).toBe(false);
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("fails closed when a concurrent decision wins before request-revision writes", async () => {
    const dbStub = createDbStub([[createApproval("pending")]], []);

    await expect(
      approvalService(dbStub.db as any).requestRevision("approval-1", "board", "clarify"),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "approval_revision_request_not_applied",
        approvalId: "approval-1",
      },
    });
  });

  it("fails closed when a concurrent decision wins before resubmit writes", async () => {
    const dbStub = createDbStub([[createApproval("revision_requested")]], []);

    await expect(
      approvalService(dbStub.db as any).resubmit("approval-1"),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "approval_resubmit_not_applied",
        approvalId: "approval-1",
      },
    });
  });
});

describe("approvalService.findOpenHireApprovalForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the open hire approval the company/type/status/agentId filter yields", async () => {
    const match = {
      ...createApproval("pending"),
      id: "approval-match",
      payload: { agentId: "agent-1" },
    };
    // The company, type, open-status and payload->>'agentId' predicates run in
    // SQL, so the DB hands back only the matching row.
    const dbStub = createDbStub([[match]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result?.id).toBe("approval-match");
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("returns null when no open approval matches the agent", async () => {
    const dbStub = createDbStub([[]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result).toBeNull();
  });
});
