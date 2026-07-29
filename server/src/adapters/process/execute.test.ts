import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import { buildProcessExecutionContextEnv, execute } from "./execute.js";

function buildContext(): Pick<AdapterExecutionContext, "runId" | "agent" | "context"> {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
    } as AdapterExecutionContext["agent"],
    context: {
      issueId: "issue-123",
      projectId: "project-123",
      executionWorkspaceId: "execution-workspace-123",
      paperclipIssue: {
        id: "issue-123",
        identifier: "FAC-7",
        workMode: "execution",
      },
      paperclipWorkspace: {
        cwd: "C:\\repo",
        source: "project_primary",
        strategy: "shared_workspace",
        projectId: "project-123",
        workspaceId: "project-workspace-123",
        repoUrl: "https://github.com/iMelki/example.git",
        repoRef: "dev",
        branchName: "dev",
        worktreePath: "C:\\repo",
        agentHome: "C:\\paperclip\\agents\\agent-123",
      },
      paperclipWorkspaces: [
        {
          id: "project-workspace-123",
          cwd: "C:\\repo",
        },
      ],
      paperclipEnvironment: {
        id: "environment-123",
        driver: "local",
        leaseId: "lease-123",
      },
    },
  };
}

describe("buildProcessExecutionContextEnv", () => {
  it("exposes resolved validator identity and workspace context", () => {
    const env = buildProcessExecutionContextEnv(buildContext());

    expect(env).toMatchObject({
      PAPERCLIP_RUN_ID: "run-123",
      PAPERCLIP_AGENT_ID: "agent-123",
      PAPERCLIP_COMPANY_ID: "company-123",
      PAPERCLIP_TASK_ID: "issue-123",
      PAPERCLIP_ISSUE_ID: "issue-123",
      PAPERCLIP_ISSUE_IDENTIFIER: "FAC-7",
      PAPERCLIP_ISSUE_WORK_MODE: "execution",
      PAPERCLIP_PROJECT_ID: "project-123",
      PAPERCLIP_EXECUTION_WORKSPACE_ID: "execution-workspace-123",
      PAPERCLIP_PROJECT_WORKSPACE_ID: "project-workspace-123",
      PAPERCLIP_WORKSPACE_CWD: "C:\\repo",
      PAPERCLIP_WORKSPACE_REPO_URL: "https://github.com/iMelki/example.git",
      PAPERCLIP_WORKSPACE_BRANCH: "dev",
      PAPERCLIP_ENVIRONMENT_ID: "environment-123",
      PAPERCLIP_ENVIRONMENT_DRIVER: "local",
    });
    expect(JSON.parse(env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        id: "project-workspace-123",
        cwd: "C:\\repo",
      },
    ]);
  });

  it("emits a versioned secret-free JSON contract for deterministic validators", () => {
    const env = buildProcessExecutionContextEnv(buildContext());
    const payload = JSON.parse(env.PAPERCLIP_VALIDATOR_CONTEXT_JSON);

    expect(payload).toEqual({
      schemaVersion: "paperclip.process-context.v1",
      runId: "run-123",
      companyId: "company-123",
      agentId: "agent-123",
      issue: {
        id: "issue-123",
        identifier: "FAC-7",
        workMode: "execution",
      },
      projectId: "project-123",
      executionWorkspace: {
        id: "execution-workspace-123",
        projectWorkspaceId: "project-workspace-123",
        cwd: "C:\\repo",
        source: "project_primary",
        strategy: "shared_workspace",
        repoUrl: "https://github.com/iMelki/example.git",
        repoRef: "dev",
        branchName: "dev",
        worktreePath: "C:\\repo",
      },
      environment: {
        id: "environment-123",
        driver: "local",
        leaseId: "lease-123",
      },
    });
    expect(env.PAPERCLIP_VALIDATOR_CONTEXT_JSON).not.toContain("API_KEY");
  });

  it("falls back to legacy task identity without inventing optional fields", () => {
    const minimal = buildContext();
    minimal.context = { taskId: "legacy-task" };

    const env = buildProcessExecutionContextEnv(minimal);
    const payload = JSON.parse(env.PAPERCLIP_VALIDATOR_CONTEXT_JSON);

    expect(env.PAPERCLIP_ISSUE_ID).toBe("legacy-task");
    expect(env.PAPERCLIP_ISSUE_IDENTIFIER).toBeUndefined();
    expect(payload.issue).toEqual({
      id: "legacy-task",
      identifier: null,
      workMode: null,
    });
    expect(payload.executionWorkspace.cwd).toBeNull();
  });

  it("launches from the resolved workspace and protects managed context from config overrides", async () => {
    const base = buildContext();
    const workspace = process.cwd();
    base.context = {
      ...base.context,
      paperclipWorkspace: {
        ...(base.context.paperclipWorkspace as Record<string, unknown>),
        cwd: workspace,
      },
    };
    const result = await execute({
      ...base,
      runtime: {} as AdapterExecutionContext["runtime"],
      config: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({cwd:process.cwd(),issueId:process.env.PAPERCLIP_ISSUE_ID,custom:process.env.CUSTOM_VALUE}))",
        ],
        cwd: process.env.TEMP ?? workspace,
        env: {
          PAPERCLIP_ISSUE_ID: "config-must-not-win",
          CUSTOM_VALUE: "forwarded",
        },
        timeoutSec: 15,
      },
      onLog: async () => {},
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(
      (result.resultJson as { stdout: string }).stdout,
    ) as { cwd: string; issueId: string; custom: string };
    expect(payload.cwd.toLowerCase()).toBe(workspace.toLowerCase());
    expect(payload.issueId).toBe("issue-123");
    expect(payload.custom).toBe("forwarded");
  });
});
