# Copy-DB migration, restore and runtime proofs — issue #252

This records the proofs for #252 item 2 (runtime start on a copy, bound to the
tree named below, not to the current head) and item 3 (isolated migration proof
and restore of a `COPY`-format dump through `psql`). Both runs used a **copy**
of a production DB backup in an isolated Postgres cluster. Neither run
connected to the live DB or started or stopped the live server. The only
live-side actions were locating the newest backup file and making one read-only
copy of it.

Raw logs, scripts and per-table count files were kept privately because they
contain host paths and record identifiers. This file holds the counts and
results only.

| Item | Result | Tree tested |
| --- | --- | --- |
| 3. Migration 0216 → 0234 on a copy | PASS | `dev` at `8a9c270d8f3dfe03f24bf966022c6077289c5bec` |
| 3. Restore of a `COPY`-format dump through `psql` | PASS, 0 row-count mismatches; the no-`psql` fallback restore in `backup-lib.ts` was not run | same |
| 2. Runtime start on a migrated, neutralized copy | PASS, with the limits below | same |

## Scope: which tree this proves

Both proofs are bound to `8a9c270d`, which was the tip of `dev` on 2026-11-10.
Since then `dev` gained no new migration files, so the set of migrations proven
here is still current. Other code on the paths these proofs rely on **did**
change after `8a9c270d`.

**Rule for a later head.** Before a live update from a head later than
`8a9c270d`, run:

```sh
git diff --stat 8a9c270d <head>
```

Run it with no path filter. Changes outside `server/` and `packages/` also
reach these paths: patched dependencies (`patches/`), the root `package.json`
and `pnpm-lock.yaml` (the proofs ran `pnpm install --frozen-lockfile`), and
the packaging scripts under `scripts/`. Each listed file on the startup,
migration, backup, restore or install path needs one of these:

- a fresh runtime and migration check at that head; or
- a reviewed note that says why the proofs below still cover that change.

The list below is the known delta at `edb5daf9`, the commit that added this
file. At that commit the command lists 223 files (16,299 insertions, 1,245
deletions); 155 of them are under `server/` and `packages/`. A later head can
add files. Use the command, not this list, as the complete set.

### Startup, scheduler-off path (item 2 ran this path at `8a9c270d`)

- `server/src/index.ts` (#247, #257). Startup sweeps now go through a bounded
  sweep scheduler (new `server/src/services/heartbeat-scheduler-sweeps.ts`). Its
  concurrency comes from the new `effectiveDatabasePoolMax()` in
  `packages/db/src/client.ts`, exported from `packages/db/src/index.ts`. With
  the scheduler disabled, startup still schedules the environment-lease cleanup
  sweep and the external-object refresh sweep, which now go through the new
  `trackBoundedSweep`. Shutdown now sets the stop flag before the systemd
  notification.
- `server/src/config.ts` (#257). New `nativeGitHubProjectSchedulingEnabled`, set
  only by `PAPERCLIP_GITHUB_PROJECT_SCHEDULER_ENABLED=true`. It is off by
  default. The proof did not set it.
- `server/src/app.ts` (#257). Adds the GitHub project-board scheduler bridge
  (new `plugin-github-project-board-scheduler-bridge.ts`) and a plugin job
  dispatch plan (new `plugin-job-scope.ts`). Shutdown now stops the plugin job
  scheduler, the job coordinator and the bridge.
- `server/src/services/plugin-job-scheduler.ts`, with `plugin-job-batch.ts`
  (new), `plugin-job-store.ts` and `plugin-job-coordinator.ts` (#244, #257).
  `createApp` starts the plugin job scheduler whatever
  `HEARTBEAT_SCHEDULER_ENABLED` is. Its tick reads active, due `plugin_jobs`
  rows. The dispatch and run code was rewritten. The proof paused all plugin
  jobs, so the new dispatch code was not run.
- `server/src/services/plugin-loader.ts` and `plugin-database.ts`, with the new
  `short-transaction.ts` (#247, #257). Plugin load now reconciles job
  declarations through the bridge. For a ready GitHub project importer plugin,
  this inserts a paused board job row even when the bridge is disabled. Plugin
  install now reads migration files before its transaction. The proof had no
  ready plugins, so neither path ran.
- `server/src/services/built-in-agents.ts` (116 insertions, 5 deletions; #244,
  #249), with the new `company-actor-user.ts` and changes in `routines.ts`
  (#244, #246). This is
  `reconcileBuiltInAgentsOnStartup`. Finding 1 and Finding 3 were observed at
  `8a9c270d`; see the notes there.
- `server/src/services/question-response-delivery.ts` (#255). This is the
  startup sweep listed under item 2. Its wake behaviour changed; see the note
  there.
- `server/src/services/heartbeat.ts` (299 insertions, 168 deletions; #244,
  #245, #246, #247, #250). The wake path that the question-response sweep calls now replaces the
  `built-in-bundles` responsible user with an eligible company member. The claim
  of a queued run now runs in one transaction. ACPX provider-quota holds now
  suppress timer wakes, missing-comment retries and recovery wakes. The proof
  had 0 pending deliveries and 0 new wakeups, so it did not run this code.

### Scheduler-on path (not run at either tree)

- `server/src/services/heartbeat.ts` (queued-run claim, `resumeQueuedRuns`,
  `tickTimers`), `recovery/service.ts`, the new
  `recovery/acpx-provider-quota.ts`, `decision-retention.ts`, `routines.ts`
  (scheduled triggers) and `tool-access.ts` (with the new
  `tool-connection-mutation-lock.ts`).

### Migration, backup and restore path (`packages/db`, #257)

- `backup-lib.ts`. The fallback restore used when no `psql` is available now
  streams each `COPY` block through the `COPY` protocol. The proof restored
  through `psql`, so this code did not run.
- `migration-runtime.ts` and the new `embedded-postgres-lock.ts`. These change
  how the migration runner adopts and locks an embedded Postgres. The proof used
  an external `DATABASE_URL`, so this code did not run. A live update of an
  embedded instance does run it.
- `client.ts` (#247). Adds only `effectiveDatabasePoolMax()` and
  `POSTGRES_JS_DEFAULT_POOL_MAX`. The migration and journal code is unchanged.
- `package.json`. Adds `postgres` to `bundleDependencies`. This changes the
  packed `@paperclipai/db` package. The proofs ran from a source checkout.

### Outside `server/` and `packages/` (install and restore path)

- `patches/postgres@3.4.9.patch` (new, #257), registered in the root
  `package.json` `pnpm.patchedDependencies` and pinned by hash in
  `pnpm-lock.yaml`. It patches the `postgres` driver's `src/connection.js`,
  which `packages/db` uses for migrations and `runDatabaseRestore`: how a
  COPY FROM STDIN stream ends or fails (`CopyInResponse`/`CopyBothResponse`,
  `ErrorResponse`), plus a `settleFinal()` call in `errored()`. The fallback
  restore in `backup-lib.ts` (no `psql`) now streams through exactly this code.
  Neither proof ran against the patched driver.
- `scripts/cli-bundled-npm-dependencies.mjs` and
  `scripts/prepare-bundled-package.mjs` (#257). They add `postgres` to the
  bundled CLI dependencies and require the patched driver when packing; this
  is the reason for the `bundleDependencies` change above.
- `test-embedded-postgres.ts`. Test helper only.

### Request path

- `server/src/middleware/auth.ts` (#244). Agent JWT and agent API key requests
  now replace the `built-in-bundles` responsible user with an eligible company
  member. The proof made only board reads in `local_trusted` mode, so this code
  did not run.
- `server/src/middleware/redact-sensitive.ts` (#217). HTTP log redaction now
  matches more key forms. It does not change response bodies.

### Outside these paths

These changed but are not on the startup, migration, backup or restore path:

- `workspace-runtime.ts` (#256). The change is in the reuse of a running service
  during a run or a workspace control action. It is not in
  `reconcilePersistedRuntimeServicesOnStartup`.
- adapter execution and timeouts: `packages/adapters/*`,
  `packages/adapter-utils/*` and `server/src/adapters/*`;
- GitHub project board and OAuth services and routes, `issues.ts`,
  `plugin-imported-issues.ts` and other `server/src/routes/*` files;
- `packages/shared` (a telemetry event and plugin types; telemetry was disabled
  in the proof), `packages/plugins/sdk/src/testing.ts` and a runner-core test;
- test files.

## Correction to #252 item 3

As of the backup (2026-10-20), the deployed schema level was fork migration
**`0215_complete_dragon_lord`**, not 0214. The restored backup's migration
journal shows 214 of 233 `dev` migration files applied, the last one being 0215
(subject to the unexplained journal gap noted below). The proven range is
therefore **0216 → 0234**. The live DB was not read, so its level today is
unverified.

## Backup used

| Field | Value |
| --- | --- |
| File | newest backup found, gzip-compressed SQL dump |
| Created | 2026-10-20T18:30:24Z, about 21 days before the runs |
| Size | 14,259,107 bytes compressed, 120,790,827 bytes SQL; `gzip -t` OK |
| Integrity | SHA-256 of source and copy matched |
| Format | Paperclip dump: 85 `COPY ... FROM stdin` blocks, 157,584 data rows |

## Item 3: migration and restore

**Isolated clusters.** Two fresh clusters were created with the repo's own
embedded Postgres (`@embedded-postgres/windows-x64@18.1.0-beta.16`, the version
the repo pins), bound to `127.0.0.1` only, with throwaway
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
  rows (286) than the 214 applied `dev` files before migration. The 72-row gap
  was observed and not explained. After migration `inspectMigrations` reported
  `upToDate`, but that result does not account for the gap.
- Public tables went from 174 to 185. The 11 new tables are empty:
  `adapter_auth_sessions`, `company_onboarding_seeds`, `company_transfer_runs`,
  `completion_contracts`, `execution_workspace_runtime_leases`,
  `issue_question_response_deliveries`, `native_run_finalizations`,
  `native_run_results`, `status_decision_effects`, `status_decisions`,
  `work_assessments`.
- No table that existed before the migration was dropped. (Within the range,
  0225 creates `claude_setup_token_sessions` and 0229 drops it again.) No
  existing table's row count changed, apart from the drizzle journal. Spot reads before and after: companies 2, issues 628,
  agents 19.

**Restore proof** (copy B): the same pre-migration backup was restored into a
second fresh cluster (16.6 s in the restore function).

| Check | Result |
| --- | --- |
| Source dump, per-table `COPY` row counts | 85 tables, 157,584 rows |
| Copy B, exact `count(*)` per table | 175 tables (the 174 public tables plus one more, likely the drizzle journal; see "Limits"), 157,584 rows, **0 mismatches**; the 90 tables with no `COPY` block hold 0 rows |
| Copy A before migration vs copy B | identical per-table count files |
| Copy B drizzle journal | 286 rows, same last hash as copy A before migration |

Postgres logs for both clusters had no `ERROR`, `FATAL` or `PANIC` lines.

## Item 2: runtime start

The first lane did not start the server. Reading `server/src/index.ts` showed
startup work that runs even with `HEARTBEAT_SCHEDULER_ENABLED=false`:

- the question-response delivery sweep, which calls `heartbeat.wakeup`
  (`wakeOnDemand` defaults to true when absent). This is the behaviour at
  `8a9c270d`, where the wake did not check the continuation policy. At
  `edb5daf9`, when the sweep cannot steer the answer into a running native
  turn, it wakes the assignee only when the interaction's
  `continuationPolicy` is `wake_assignee`. For any other policy it records the
  delivery as `delivered` with error code
  `question_response_continuation_disabled` and does not wake. The sweep now
  also orders pending rows by `updatedAt`, then `createdAt`. The proof did not
  run this code: it failed every pending delivery before the start;
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
   keys). They stayed paused, with heartbeat and wake-on-demand off. This was
   observed on a copy whose `adapter_config` had been emptied, so it may be a
   no-op on populated live configs. It does mean that neutralizing those two
   agents in the DB does not survive a start.

   **Changed after the tested tree.** This was observed at `8a9c270d`.
   `built-in-agents.ts` changed after it (116 insertions, 5 deletions). At `edb5daf9`:

   - Startup still calls `ensure` for each existing bundled agent (`provision`
     when the company requires board approval for new agents). When the
     stored `adapter_config` is complete, `ensure` keeps it, as it did at
     `8a9c270d`.
   - When the stored config is not complete and the adapter type stays the
     same, `ensure` now merges the default config onto the stored one. At
     `8a9c270d` it replaced the stored one. It writes `adapter_config` only
     when the result is not effectively equal to the stored config. The
     comparison normalizes the `paperclipSkillSync` value (entry order, and
     plain keys against `{ key, versionId: null }`).
   - Bundled skill sync now skips the write when the effective skill set does
     not change. At `8a9c270d` it always wrote.

   So on populated live configs, startup now writes less often than at
   `8a9c270d`. On an emptied config like the one tested, the defaults still
   differ from `{}`, so a rewrite is still expected. This was not run at
   `edb5daf9`. Do not rely on this finding at a later head without a check at
   that head.
2. **The server needs a plugin-sdk build first.** Without it the server exits
   with `ERR_MODULE_NOT_FOUND` for `@paperclipai/plugin-sdk/dist`. `pnpm dev`
   already builds it; a direct `tsx src/index.ts` start does not.
3. **Startup also wrote** 1 `built_in_agent.routine_reconciled` activity row
   (routines stayed paused), 8 permission grants and 1 membership for the
   `local-board` principal.

   **Changed after the tested tree.** At `edb5daf9`, when startup creates or
   resets a built-in routine, the actor is no longer the fixed
   `built-in-bundles` user. It is the routine's stored responsible user if that
   user exists and has active, write-capable company access. If not, it is an
   eligible company member, resolved by the new `company-actor-user.ts`. If
   no member is eligible, the routine is written with no responsible user.
   At `8a9c270d` a created routine got `built-in-bundles` as its responsible
   user, and an update kept the stored value. The written responsible user can
   therefore differ. This was not run at `edb5daf9`.

## Limits

- **Unexplained journal gap and unidentified table.** The migration journal held
  72 more rows than applied `dev` files, and the exact count found 175 tables
  against 174 public ones. Neither was investigated. The 175th table is likely
  the drizzle migration journal, `drizzle.__drizzle_migrations`. The migration
  runner creates it in the `drizzle` schema when no journal exists
  (`ensureMigrationJournalTable` in `packages/db/src/client.ts`). The repo's
  backup code dumps every non-system schema, not only `public`. Copy B was
  built only by the restore and held a 286-row journal, so the journal was in
  the dump. This is likely, not verified: this record does not name the 175
  tables, and the private count files were not re-read for this note.
- **Disabled scheduler only.** The scheduler-on path was not exercised: the
  orphan reaper, `resumeQueuedRuns`, routine and status-card ticks, and tool
  health sweeps. After `8a9c270d`, #247 and #257 changed both the scheduler-on
  and the scheduler-off startup paths, and other changes reached the
  built-in agent reconcile and the question-response sweep (see "Scope"
  above).
- **Not tested:** authenticated mode, the UI, plugin loading (no ready plugins)
  and graceful shutdown. The server was killed after an identity check.
- **Main thread only.** The guard covered the main thread; `worker_threads`
  code would not be covered (none was seen).
- **Old data.** The backup is about 21 days old, and the live DB itself was not
  read, so its current schema level is unverified. The 0215 level is the
  backup's, as of 2026-10-20.
- **Not production state.** The runtime proof ran on a neutralized copy: agent
  configs, secrets and tokens were removed and the scheduler was off. Finding 1
  shows startup changes state regardless.
- **Not reproducible from the repo.** The raw logs and scripts are private, so
  only the counts here can be checked, not re-run from this repository.
- **Client version.** The restore used a PostgreSQL 17 `psql` against the
  PostgreSQL 18 server.
- **No live rollback rehearsal.** Item 3 asks only for the pre-migration copy
  restore shown above.

## Cleanup

Both Postgres clusters were stopped with `pg_ctl stop -m fast`. Every process
the lanes started was stopped after a PID and start-time check; the ports were
free afterwards. The cluster data folders and the backup copies, which held
full copies of production data, were moved to the Recycle Bin and checked absent.
