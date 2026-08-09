import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  applyPaperclipWorkspaceEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function assignIfPresent(env: Record<string, string>, key: string, value: unknown) {
  const normalized = readNonEmptyString(value);
  if (normalized) env[key] = normalized;
}

export function buildProcessExecutionContextEnv(
  ctx: Pick<AdapterExecutionContext, "runId" | "agent" | "context">,
): Record<string, string> {
  const issue = parseObject(ctx.context.paperclipIssue);
  const workspace = parseObject(ctx.context.paperclipWorkspace);
  const environment = parseObject(ctx.context.paperclipEnvironment);
  const issueId =
    readNonEmptyString(issue.id) ??
    readNonEmptyString(ctx.context.issueId) ??
    readNonEmptyString(ctx.context.taskId);
  const projectId =
    readNonEmptyString(ctx.context.projectId) ??
    readNonEmptyString(workspace.projectId);
  const executionWorkspaceId = readNonEmptyString(ctx.context.executionWorkspaceId);

  const env: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
  };
  assignIfPresent(env, "PAPERCLIP_TASK_ID", issueId);
  assignIfPresent(env, "PAPERCLIP_ISSUE_ID", issueId);
  assignIfPresent(env, "PAPERCLIP_ISSUE_IDENTIFIER", issue.identifier);
  assignIfPresent(env, "PAPERCLIP_ISSUE_WORK_MODE", issue.workMode);
  assignIfPresent(env, "PAPERCLIP_PROJECT_ID", projectId);
  assignIfPresent(env, "PAPERCLIP_EXECUTION_WORKSPACE_ID", executionWorkspaceId);
  assignIfPresent(env, "PAPERCLIP_PROJECT_WORKSPACE_ID", workspace.workspaceId);
  assignIfPresent(env, "PAPERCLIP_ENVIRONMENT_ID", environment.id);
  assignIfPresent(env, "PAPERCLIP_ENVIRONMENT_DRIVER", environment.driver);

  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: readNonEmptyString(workspace.cwd),
    workspaceSource: readNonEmptyString(workspace.source),
    workspaceStrategy: readNonEmptyString(workspace.strategy),
    workspaceId: readNonEmptyString(workspace.workspaceId),
    workspaceRepoUrl: readNonEmptyString(workspace.repoUrl),
    workspaceRepoRef: readNonEmptyString(workspace.repoRef),
    workspaceBranch: readNonEmptyString(workspace.branchName),
    workspaceWorktreePath: readNonEmptyString(workspace.worktreePath),
    agentHome: readNonEmptyString(workspace.agentHome),
  });

  const workspaceHints = Array.isArray(ctx.context.paperclipWorkspaces)
    ? ctx.context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null,
      )
    : [];
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }

  env.PAPERCLIP_VALIDATOR_CONTEXT_JSON = JSON.stringify({
    schemaVersion: "paperclip.process-context.v1",
    runId: ctx.runId,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    issue: issueId
      ? {
          id: issueId,
          identifier: readNonEmptyString(issue.identifier),
          workMode: readNonEmptyString(issue.workMode),
        }
      : null,
    projectId,
    executionWorkspace: {
      id: executionWorkspaceId,
      projectWorkspaceId: readNonEmptyString(workspace.workspaceId),
      cwd: readNonEmptyString(workspace.cwd),
      source: readNonEmptyString(workspace.source),
      strategy: readNonEmptyString(workspace.strategy),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
      branchName: readNonEmptyString(workspace.branchName),
      worktreePath: readNonEmptyString(workspace.worktreePath),
    },
    environment: {
      id: readNonEmptyString(environment.id),
      driver: readNonEmptyString(environment.driver),
      leaseId: readNonEmptyString(environment.leaseId),
    },
  });

  return env;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, config, context, onLog, onMeta, authToken } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const workspace = parseObject(context.paperclipWorkspace);
  const cwd = asString(workspace.cwd, "") || asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env = buildProcessExecutionContextEnv(ctx);
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v !== "string") continue;
    // Runtime PAPERCLIP_* always wins over config, and PAPERCLIP_API_KEY is
    // never accepted from config — the harness-minted run token is the only
    // source. Other PAPERCLIP_* keys Paperclip did not assign flow through.
    if (isForbiddenConfigEnvKey(k)) continue;
    if (isPaperclipRuntimeEnvKey(k) && k in env) continue;
    env[k] = v;
  }
  if (authToken) env.PAPERCLIP_API_KEY = authToken;
  // runtimeEnv is only used to resolve the command path and log HOME below;
  // the child env is built inside runChildProcess from
  // sanitizeInheritedPaperclipEnv(process.env) + env, so a PAPERCLIP_API_KEY
  // on the server process never reaches the child.
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn: ctx.onSpawn,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
