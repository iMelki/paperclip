import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDatabaseBackupOptions, RunDatabaseBackupResult } from "../../../packages/db/src/backup-lib.js";
import { errorHandler } from "../middleware/index.js";
import {
  instanceDatabaseBackupRoutes,
  type InstanceDatabaseBackupRunResult,
  type InstanceDatabaseBackupService,
  type InstanceDatabaseBackupTrigger,
} from "../routes/instance-database-backups.js";
import { conflict } from "../errors.js";

const serverSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const adminActor = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true };

function findNodes<T extends ts.Node>(source: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function parseServerSource(source: string) {
  return ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function getServerBindings(source: string) {
  const parsed = parseServerSource(source);
  const servers = parsed.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "startServer");
  expect(servers).toHaveLength(1);
  expect(servers[0].body).toBeDefined();
  const body = servers[0].body!;
  const variables = body.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations]);
  const named = (name: string) => variables.filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
  expect(named("runServerDatabaseBackup")).toHaveLength(1);
  expect(named("databaseBackupInFlight")).toHaveLength(1);
  const runner = named("runServerDatabaseBackup")[0].initializer;
  const mutex = named("databaseBackupInFlight")[0];
  expect(mutex.initializer?.kind).toBe(ts.SyntaxKind.FalseKeyword);
  expect(mutex.parent.flags & ts.NodeFlags.Let).toBeTruthy();
  expect(runner && ts.isArrowFunction(runner)).toBe(true);
  expect(runner && ts.isArrowFunction(runner)
    && runner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)).toBe(true);
  expect(named("app")).toHaveLength(1);
  const app = named("app")[0].initializer;
  expect(app && ts.isAwaitExpression(app) && ts.isCallExpression(app.expression)
    && ts.isIdentifier(app.expression.expression) && app.expression.expression.text === "createApp").toBe(true);
  const options = (app as ts.AwaitExpression).expression as ts.CallExpression;
  const services = findNodes(options.arguments[1], (node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && node.parent === options.arguments[1]
    && node.name.getText(parsed) === "databaseBackupService");
  expect(services).toHaveLength(1);
  const manual = findNodes(services[0].initializer, (node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && node.parent === services[0].initializer
    && node.name.getText(parsed) === "runManualBackup");
  expect(manual).toHaveLength(1);
  expect(ts.isArrowFunction(manual[0].initializer)).toBe(true);
  return { parsed, body, mutex: mutex.getText(parsed), runner: runner!.getText(parsed),
    manual: manual[0].initializer.getText(parsed) };
}

// Execute only the two owned caller arrows, never import/boot index.ts. This is
// source-projected caller proof, not installed startup or scheduler evidence.
// Compiler API: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
function projectBackupCaller(source = serverSource) {
  const arrows = getServerBindings(source);
  const retention = { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 };
  const result: RunDatabaseBackupResult = {
    backupFile: "synthetic/paperclip-final.sql.gz", sizeBytes: 1234, prunedCount: 0,
    backupEngine: "pg_dump", preservationPolicy: "preserve-all",
    retainedPartialFile: "paperclip-final.sql.gz.partial-synthetic",
  };
  const dependencies = {
    config: { databaseBackupDir: "synthetic" },
    activeDatabaseConnectionString: "postgresql://synthetic.invalid/example",
    backupSettingsSvc: { getGeneral: vi.fn().mockResolvedValue({ backupRetention: retention }) },
    runDatabaseBackup: vi.fn<(options: RunDatabaseBackupOptions) => Promise<RunDatabaseBackupResult>>()
      .mockResolvedValue(result),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    conflict, formatDatabaseBackupResult: vi.fn().mockReturnValue("synthetic complete"),
  };
  const projected = `const project = (dependencies) => {
    const { ${Object.keys(dependencies).join(", ")} } = dependencies;
    let ${arrows.mutex};
    const runServerDatabaseBackup = ${arrows.runner};
    return { run: runServerDatabaseBackup, service: { runManualBackup: ${arrows.manual} } };
  };`;
  const compiled = ts.transpileModule(projected, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  expect(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
  const caller = new Function("dependencies", `"use strict";\n${compiled.outputText}\nreturn project(dependencies);`)(dependencies) as {
    run(trigger: InstanceDatabaseBackupTrigger): Promise<InstanceDatabaseBackupRunResult | null>;
    service: InstanceDatabaseBackupService;
  };
  return { ...caller, ...dependencies, result, retention };
}

function assertStrictPolicy(caller: ReturnType<typeof projectBackupCaller>) {
  const options = caller.runDatabaseBackup.mock.calls[0]?.[0];
  expect(options?.backupEngine, "backupEngine must select pg_dump").toBe("pg_dump");
  expect(options?.preserveAll, "preserveAll must prevent deletion/fallback").toBe(true);
  expect(caller.runDatabaseBackup).toHaveBeenCalledExactlyOnceWith({
    connectionString: caller.activeDatabaseConnectionString, backupDir: "synthetic",
    retention: caller.retention, filenamePrefix: "paperclip", backupEngine: "pg_dump", preserveAll: true,
  });
}

function createApp(actor: Record<string, unknown>, service: InstanceDatabaseBackupService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", instanceDatabaseBackupRoutes(service));
  app.use(errorHandler);
  return app;
}

function createBackupService(overrides: Partial<InstanceDatabaseBackupService> = {}): InstanceDatabaseBackupService {
  return {
    runManualBackup: vi.fn().mockResolvedValue({
      trigger: "manual",
      backupFile: "/tmp/paperclip-20260416.sql.gz",
      sizeBytes: 1234,
      prunedCount: 2,
      backupDir: "/tmp",
      retention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
      startedAt: "2026-04-16T20:00:00.000Z",
      finishedAt: "2026-04-16T20:00:01.000Z",
      durationMs: 1000,
    }),
    ...overrides,
  };
}

describe("instance database backup routes", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("runs a manual backup for an instance admin and returns the server result", async () => {
    const service = createBackupService();
    const app = createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      },
      service,
    );

    const res = await request(app).post("/api/instance/database-backups").send({});

    expect(res.status).toBe(201);
    expect(service.runManualBackup).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      trigger: "manual",
      backupFile: "/tmp/paperclip-20260416.sql.gz",
      sizeBytes: 1234,
      prunedCount: 2,
      backupDir: "/tmp",
      retention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
      startedAt: "2026-04-16T20:00:00.000Z",
      finishedAt: "2026-04-16T20:00:01.000Z",
      durationMs: 1000,
    });
  });

  it("allows local implicit board access", async () => {
    const service = createBackupService();
    const app = createApp(
      {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: false,
      },
      service,
    );

    await request(app).post("/api/instance/database-backups").send({}).expect(201);

    expect(service.runManualBackup).toHaveBeenCalledTimes(1);
  });

  it("rejects non-admin board users", async () => {
    const service = createBackupService();
    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      },
      service,
    );

    await request(app).post("/api/instance/database-backups").send({}).expect(403);

    expect(service.runManualBackup).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const service = createBackupService();
    const app = createApp(
      {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
      },
      service,
    );

    await request(app).post("/api/instance/database-backups").send({}).expect(403);

    expect(service.runManualBackup).not.toHaveBeenCalled();
  });

  it("returns conflict when another server backup is already running", async () => {
    const service = createBackupService({
      runManualBackup: vi.fn().mockRejectedValue(conflict("Database backup already in progress")),
    });
    const app = createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      },
      service,
    );

    const res = await request(app).post("/api/instance/database-backups").send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Database backup already in progress" });
  });

  describe("cloud-managed floor", () => {
    beforeEach(() => {
      vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "test-server-token");
    });

    it("floors the manual trigger off for every instance admin on a cloud-managed instance", async () => {
      const service = createBackupService();
      const app = createApp(
        {
          type: "board",
          userId: "admin-1",
          source: "session",
          isInstanceAdmin: true,
        },
        service,
      );

      const res = await request(app).post("/api/instance/database-backups").send({});

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "database_backups_platform_managed" });
      expect(service.runManualBackup).not.toHaveBeenCalled();
    });

    it("floors the manual trigger off for a computed cloud_tenant owner-admin", async () => {
      const service = createBackupService();
      const app = createApp(
        {
          type: "board",
          userId: "owner-1",
          source: "cloud_tenant",
          isInstanceAdmin: true,
          companyIds: ["company-1"],
        },
        service,
      );

      await request(app).post("/api/instance/database-backups").send({}).expect(403);

      expect(service.runManualBackup).not.toHaveBeenCalled();
    });
  });

  it("rejects anonymous actors without invoking the backup", async () => {
    const caller = projectBackupCaller();
    await request(createApp({ type: "none" }, caller.service))
      .post("/api/instance/database-backups").send({}).expect(403);
    expect(caller.runDatabaseBackup).not.toHaveBeenCalled();
  });

  it("floors off a managed-config-only instance without invoking the backup", async () => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", "{}");
    const caller = projectBackupCaller();
    const res = await request(createApp(adminActor, caller.service))
      .post("/api/instance/database-backups").send({});
    expect(res.status).toBe(403);
    expect(res.body.details).toEqual({ code: "database_backups_platform_managed" });
    expect(caller.runDatabaseBackup).not.toHaveBeenCalled();
  });
});

describe("source-projected server database backup caller", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("selects strict native preservation from the real manual adapter, ignoring request overrides", async () => {
    const caller = projectBackupCaller();
    const res = await request(createApp(adminActor, caller.service))
      .post("/api/instance/database-backups")
      .send({ backupEngine: "javascript", preserveAll: false, backupDir: "untrusted-override" });
    expect(res.status).toBe(201);
    assertStrictPolicy(caller);
    expect(res.body).toMatchObject({ ...caller.result, trigger: "manual", retention: caller.retention });
    expect(res.body.startedAt).toEqual(expect.any(String));
    expect(res.body.finishedAt).toEqual(expect.any(String));
    expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("binds the existing interval to the same strict caller without running a timer", () => {
    const { parsed, body } = getServerBindings(serverSource);
    const enabled = body.statements.filter((node): node is ts.IfStatement =>
      ts.isIfStatement(node) && node.expression.getText(parsed) === "config.databaseBackupEnabled");
    expect(enabled).toHaveLength(1);
    expect(ts.isBlock(enabled[0].thenStatement)).toBe(true);
    const statements = (enabled[0].thenStatement as ts.Block).statements;
    const intervals = statements.filter(ts.isExpressionStatement).map((statement) => statement.expression)
      .filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setInterval");
    expect(intervals).toHaveLength(1);
    expect(ts.isArrowFunction(intervals[0].arguments[0])).toBe(true);
    const scheduled = intervals.flatMap((interval) => findNodes(interval.arguments[0],
      (node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === "runServerDatabaseBackup"));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].arguments).toHaveLength(1);
    expect(scheduled[0].arguments[0].getText(parsed)).toBe('"scheduled"');
  });

  it("uses strict preservation for scheduled runs and propagates preserved result fields", async () => {
    const caller = projectBackupCaller();
    const result = await caller.run("scheduled");
    assertStrictPolicy(caller);
    expect(result).toMatchObject({ ...caller.result, trigger: "scheduled", retention: caller.retention });
  });

  it("shares the real busy flag between manual and scheduled callers, releasing it after completion", async () => {
    const caller = projectBackupCaller();
    let resolvePending!: (result: RunDatabaseBackupResult) => void;
    const pending = {
      promise: new Promise<RunDatabaseBackupResult>((resolve) => { resolvePending = resolve; }),
      resolve: (result: RunDatabaseBackupResult) => resolvePending(result),
    };
    caller.runDatabaseBackup.mockReturnValueOnce(pending.promise);
    const first = caller.service.runManualBackup();
    await vi.waitFor(() => expect(caller.runDatabaseBackup).toHaveBeenCalledTimes(1));
    await expect(caller.run("scheduled")).resolves.toBeNull();
    await request(createApp(adminActor, caller.service))
      .post("/api/instance/database-backups").send({}).expect(409);
    expect(caller.runDatabaseBackup).toHaveBeenCalledTimes(1);
    expect(caller.logger.info).toHaveBeenCalledTimes(1);
    pending.resolve(caller.result);
    await expect(first).resolves.toMatchObject({ trigger: "manual" });
    await expect(caller.run("scheduled")).resolves.toMatchObject({ trigger: "scheduled" });
    expect(caller.runDatabaseBackup).toHaveBeenCalledTimes(2);
  });

  it.each(["settings", "native"] as const)("releases the busy flag after %s failure and redacts the HTTP response", async (phase) => {
    const caller = projectBackupCaller();
    const failure = new Error("synthetic-private-credential-sentinel");
    if (phase === "settings") caller.backupSettingsSvc.getGeneral.mockRejectedValueOnce(failure);
    else caller.runDatabaseBackup.mockRejectedValueOnce(failure);
    const res = await request(createApp(adminActor, caller.service))
      .post("/api/instance/database-backups").send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    // Error-context logging is outside this response-redaction assertion.
    expect(caller.logger.error).toHaveBeenCalledTimes(1);
    await expect(caller.run("scheduled")).resolves.toMatchObject({ trigger: "scheduled" });
  });

  it.each(["backupEngine", "preserveAll"] as const)("detects a source mutant removing %s", async (option) => {
    const line = option === "backupEngine" ? '        backupEngine: "pg_dump",\n' : "        preserveAll: true,\n";
    expect(serverSource.split(line)).toHaveLength(2);
    const caller = projectBackupCaller(serverSource.replace(line, ""));
    await caller.service.runManualBackup();
    expect(() => assertStrictPolicy(caller)).toThrowError(new RegExp(`${option} must`));
  });
});
