# Copy-DB migration, restore and runtime proofs — issue #252

This records the proofs for #252 item 2 (exact-head runtime qualification)
and item 3 (isolated migration proof and `COPY`-path restore). Both runs used
a **copy** of a Factory DB backup in an isolated Postgres cluster. Neither run
connected to the live DB, started or stopped the live server, or read the live
data folder. The only live-side action was one read-only copy of a backup file.

Raw logs, scripts and per-table count files were kept privately because they
contain host paths and record identifiers. This file holds the counts and
results only.

| Item | Result | Tree tested |
| --- | --- | --- |
| 3. Migration 0216 → 0234 on a copy | PASS | `dev` at `8a9c270d8f3dfe03f24bf966022c6077289c5bec` |
| 3. Restore on the #125 `COPY` path | PASS, 0 row-count mismatches | same |
| 2. Runtime start on a migrated, neutralized copy | PASS, with the limits below | same |

## Scope: which tree this proves

Both proofs are bound to `8a9c270d`, which was the tip of `dev` on 2026-11-10.
Since then `dev` gained no new migration files, so the set of migrations proven
here is still current. Other code on these paths **did** change after
`8a9c270d`:

- **Server startup** (#247, #257). `server/src/index.ts` now runs its sweeps
  through a bounded sweep scheduler. This reaches the scheduler-off path too:
  with the scheduler disabled, startup still schedules the environment-lease
  cleanup sweep, which now goes through the new `trackBoundedSweep`.
  `server/src/app.ts` adds a GitHub project-board scheduler bridge and a new
  plugin job dispatch plan.
- **Database package** (#257). `packages/db/src/backup-lib.ts` changed the
  fallback `COPY` restore used when no `psql` is available, and
  `migration-runtime.ts` plus the new `embedded-postgres-lock.ts` changed how
  the migration runner adopts and locks an embedded Postgres. The proofs below
  did not run either path: the restore went through `psql`, and the migration
  used an external `DATABASE_URL`. A live update of an embedded instance does
  run the new runner code.

A live update from a later head therefore needs either a fresh runtime and
migration check at that head, or a reviewed note that explains why each change
above is covered.

## Correction to #252 item 3

The deployed schema level is fork migration **`0215_complete_dragon_lord`**,
not 0214. The restored backup's migration journal shows 214 of 233 `dev`
migration files applied, the last one being 0215. The proven range is
therefore **0216 → 0234**.

## Backup used

| Field | Value |
| --- | --- |
| File | `paperclip-20261020-213024.sql.gz` (newest Factory backup found) |
| Created | 2026-10-20T18:30:24Z, about 21 days before the runs |
| Size | 14,259,107 bytes compressed, 120,790,827 bytes SQL; `gzip -t` OK |
| SHA-256 | `237B069A4B748E9AFDC6241B473AC48B3473FE924A9948E3C34907F064913812` (source and copy match) |
| Format | Paperclip dump: 85 `COPY ... FROM stdin` blocks, 157,584 data rows |

## Item 3: migration and restore

**Isolated clusters.** Two fresh clusters were created with the repo's own
embedded Postgres (`@embedded-postgres/windows-x64@18.1.0-beta.16`, the same
version as the live one), bound to `127.0.0.1` only, with throwaway
credentials. The backup was restored with the repo's `runDatabaseRestore`
(`packages/db/src/backup-lib.ts`). Embedded Postgres ships no `psql`, so a
PostgreSQL 17 `psql` client was supplied through `PAPERCLIP_PSQL_PATH`.

**Migration** (copy A): `pnpm install --frozen-lockfile`, then
`pnpm --filter @paperclipai/db migrate` with `DATABASE_URL` pointing at copy A
and `PAPERCLIP_HOME` in a scratch folder.

- Exit 0 in 11.9 s, including `check:migrations`.
- Output: "Migration safety check passed: 20 historical finding(s) covered by
  baseline (1 stale baseline id(s) ignored)", "Applying 19 pending
  migration(s)...", "Migrations complete". No errors.
- Applied: `0216_onboarding_first_task_unique` through
  `0234_better_auth_account_issuer` (19 files).
- After: `inspectMigrations` reports `upToDate`, 233 of 233; the drizzle
  journal went from 286 to 305 rows, all hashes distinct. The journal held more
  rows (286) than the 214 applied `dev` files before migration; this was
  observed, not investigated, and does not change the `upToDate` result.
- Public tables went from 174 to 185. The 11 new tables are empty:
  `adapter_auth_sessions`, `company_onboarding_seeds`, `company_transfer_runs`,
  `completion_contracts`, `execution_workspace_runtime_leases`,
  `issue_question_response_deliveries`, `native_run_finalizations`,
  `native_run_results`, `status_decision_effects`, `status_decisions`,
  `work_assessments`.
- No table that existed before the migration was dropped. (Within the range,
  0217 creates `claude_setup_token_sessions` and 0229 drops it again.) No
  existing table's row count changed, apart from the drizzle journal. Spot reads before and after: companies 2, issues 628,
  agents 19.

**Restore proof** (copy B): the same pre-migration backup was restored into a
second fresh cluster (16.6 s in the restore function).

| Check | Result |
| --- | --- |
| Source dump, per-table `COPY` row counts | 85 tables, 157,584 rows |
| Copy B, exact `count(*)` per table | 175 tables (the 174 public tables plus, presumably, the drizzle journal table), 157,584 rows, **0 mismatches**; the 90 tables with no `COPY` block hold 0 rows |
| Copy A before migration vs copy B | identical per-table count files |
| Copy B drizzle journal | 286 rows, same last hash as copy A before migration |

Postgres logs for both clusters had no `ERROR`, `FATAL` or `PANIC` lines.

## Item 2: runtime start

The first lane did not start the server. Reading `server/src/index.ts` showed
startup work that runs even with `HEARTBEAT_SCHEDULER_ENABLED=false`:

- the question-response delivery sweep, which calls `heartbeat.wakeup`
  (`wakeOnDemand` defaults to true when absent);
- the environment-lease `pending_cleanup` sweep, which runs provider teardown;
- `reconcilePersistedRuntimeServicesOnStartup`,
  `reconcileCodexLocalManagedHomesOnStartup` and
  `reconcileBuiltInAgentsOnStartup`;
- the plugin loader, external adapters, telemetry and the DB backup timer.

A second lane therefore neutralized the migrated copy first.

**Neutralization.** One SQL transaction (`ON_ERROR_STOP`, refused on any port
but the copy's) made these changes:

- companies paused, feedback sharing off;
- every non-terminated agent paused and manual, with empty `adapter_config`,
  heartbeat off and every `wakeOn*` flag false;
- agent config history, runtime state and task session parameters emptied;
- non-terminal wakeup requests, thread interactions and recovery actions
  cancelled; pending question-response deliveries failed;
- recorded run `process_pid` values cleared, so no recorded OS PID can be probed;
- environments archived and leases released;
- workspace, operation and skill folder paths pointed into the scratch folder;
- routines paused, triggers disabled, plugin jobs paused, tool connections
  disabled, external-object and status-card timers cleared;
- secret material, OAuth and ID tokens, the password hash and session tokens
  removed.

A verification query returned 0 for all 24 checks of live-capable state before
the server was allowed to start.

**Server process.** `tsx src/index.ts` (what `pnpm dev:server` runs), after
`pnpm --filter @paperclipai/plugin-sdk build` (which `pnpm dev` also runs
first). The process ran windowless, with a cleared environment and only
allow-listed variables. Home, config, temp, storage and secrets folders were in
scratch. These settings were on:

- `HEARTBEAT_SCHEDULER_ENABLED=false`, `PAPERCLIP_DB_BACKUP_ENABLED=false`;
- `PAPERCLIP_MIGRATION_AUTO_APPLY=false`, `PAPERCLIP_MIGRATION_PROMPT=never`;
- `PAPERCLIP_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`;
- `SERVE_UI=false`, `PAPERCLIP_BIND=loopback`, `PAPERCLIP_DEPLOYMENT_MODE=local_trusted`;
- `PAPERCLIP_MANAGED_RUNTIME_HTTPS=off`;
- an empty bundled-plugin root;
- `HTTP_PROXY` and `HTTPS_PROXY` pointing at a dead loopback port.

A preloaded guard module logged and blocked these:

- non-loopback TCP, DNS, UDP and `fetch`;
- every `child_process` call;
- `process.kill` with a real signal;
- filesystem writes outside scratch;
- any access to the live instance's folder.

**Results** (3-minute run):

| Read (GET only) | Result |
| --- | --- |
| `/api/health` | 200 `status: ok` after 95.5 s, and again at 182.8 s |
| `/api/companies` | 200, 2 companies (DB: 2) |
| `/api/companies/{id}/issues` | 200, 500 and 70 issues (DB: 628; the first company likely hit the default page size) |
| `/api/companies/{id}/agents` | 200, 10 and 8 agents, all `paused` (DB: 19; the one terminated agent is not listed) |
| `/api/issues/{id}` | 200, id matches |
| `/api/issues/{id}/comments` | 200, 109 comments |

| Guard and process check | Count |
| --- | --- |
| Non-loopback network attempts (TCP, DNS, UDP, fetch) | 0 |
| Non-loopback TCP connections in 15-second process samples | 0 |
| Filesystem writes outside scratch | 0 |
| Accesses to the live instance folder | 0 |
| Kill attempts | 0 |
| New wakeup requests / new agent runs | 0 / 0 |
| Blocked spawns | 4: `git` (3, version and build commit), `tailscale ip -4` (1) |

The server log had 19 INFO and 27 WARN lines and no ERROR or FATAL. 26 of the
warnings were "missing heartbeat run log", because run logs live in the live
instance and were not copied.

## Findings

1. **Startup rewrites built-in agent configs.** `reconcileBuiltInAgentsOnStartup`
   rewrote `adapter_config` on the `codex_local` and `claude_local` built-in
   agents (new instructions bundle, paths, `model` and `paperclipSkillSync`
   keys). They stayed paused, with heartbeat and wake-on-demand off. A live
   start does this on every boot, so neutralizing those two agents in the DB
   does not survive a restart.
2. **The server needs a plugin-sdk build first.** Without it the server exits
   with `ERR_MODULE_NOT_FOUND` for `@paperclipai/plugin-sdk/dist`. `pnpm dev`
   already builds it; a direct `tsx src/index.ts` start does not.
3. **Startup also wrote** 1 `built_in_agent.routine_reconciled` activity row
   (routines stayed paused), 8 permission grants and 1 membership for the
   `local-board` principal.

## Limits

- **Disabled scheduler only.** The scheduler-on path was not exercised: the
  orphan reaper, `resumeQueuedRuns`, routine and status-card ticks, and tool
  health sweeps. After `8a9c270d`, #247 and #257 changed both the scheduler-on
  and the scheduler-off startup paths (see "Scope" above).
- **Not tested:** authenticated mode, the UI, plugin loading (no ready plugins)
  and graceful shutdown. The server was killed after an identity check.
- **Main thread only.** The guard covered the main thread; `worker_threads`
  code would not be covered (none was seen).
- **Old data.** The backup is about 21 days old, and the live DB itself was not
  read. Its schema level matches the live checkout's migration files (0215).
- **Client version.** The restore used a PostgreSQL 17 `psql` against the
  PostgreSQL 18 server.
- **No live rollback rehearsal.** Item 3 asks only for the pre-migration copy
  restore shown above.

## Cleanup

Both Postgres clusters were stopped with `pg_ctl stop -m fast`. Every process
the lanes started was stopped after a PID and start-time check; the ports were
free afterwards. The cluster data folders and the backup copies, which held
full copies of Factory data, were moved to the Recycle Bin and checked absent.
