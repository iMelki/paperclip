# Preserve-all backup candidate: source qualification

Issue: [Paperclip #125](https://github.com/iMelki/paperclip/issues/125).
Updated: 2026-11-18. Status: source candidate on a fork `dev`-targeted pull request, not installed or enabled.

## Intended outcome

An explicitly selected native backup must not overwrite an existing dump, prune
history, delete failed output, or fall back silently to the JavaScript exporter.
Only a completed dump should acquire the `.sql.gz` suffix used by backup health.
This is not a full recovery bundle or isolated-restore acceptance.

## Reused implementation and narrow change

`packages/db/src/backup-cli.ts` extracts the existing native backup process and
bounded stderr helpers from `backup-lib.ts`. Its pipeline-settlement helper is
adapted from MIT-licensed [upstream PR #13153](https://github.com/paperclipai/paperclip/pull/13153),
head `f2fc01afca791781f4b35c8b88d677cee1ecda59`. That PR remains unmerged; its
other timer, alert, and fallback changes were not adopted.

The opt-in `preserveAll` path requires explicit `backupEngine: "pg_dump"`, no
table/column transformations, and a restricted filename prefix. It runs before
creating the legacy SQL writer or database client. Existing callers that do not
opt in retain their existing response and retention behavior, except for the
shared connection-string handling described below, which applies to every native
dump. Restore pipeline coordination is unchanged.

The CTO accepted the exact helper contract on 2026-10-04 at 12:26 UTC in an
internal source-disposition review. That record is private and is not linked
here, so a reader of this public document cannot check it; the checks below are
the verifiable evidence.
The server selects `backupEngine: "pg_dump"` and `preserveAll: true` at its
existing shared manual/scheduled backup call **only when
`PAPERCLIP_DB_BACKUP_PRESERVE_ALL` is set to `1`/`true`/`yes`/`on`**. With the
flag unset (default) the call is unchanged: retention settings apply and the
JavaScript exporter remains the fallback when `pg_dump` is unavailable. Issue
#125 lists preserve-first as a recommended operator decision, not a mandatory
default, so the policy is opt-in. With the flag on, a missing `pg_dump` fails
with an actionable message (install the PostgreSQL client tools or set
`PAPERCLIP_PG_DUMP_PATH`). This is not enabled in the installed app and does
not authorize an app start or native backup.

If the final `link()` fails (hard links unsupported, e.g. FAT/exFAT or some
network shares), the error says so and the complete dump remains as the staging
file.

### Connection string handling (every native `pg_dump`, not only preserve-all)

`buildPgDumpInvocation` is shared by the opt-in preserve-all path and the
default path, so these changes apply to **all** native dumps, with the flag on
or off:

- `pg_dump` receives the connection URL with the password removed. The password
  is supplied through the child's `PGPASSWORD` environment variable only, so it
  never appears in argv (process listings). The parent's own `process.env` is
  never modified.
- Only the userinfo password and `password=` query pairs are cut from the raw
  string; every other byte (`%20`, `+`, `%2B`, fragments, repeated keys) is passed
  through unchanged. Passwords are percent-decoded only, as libpq does.
- As in libpq, a `password=` query parameter takes precedence over a
  `user:pass@` userinfo password; the last query pair wins. An explicit empty
  password (`user:@host` or `?password=`) sets an empty `PGPASSWORD`, so it is not
  replaced by a `PGPASSWORD` inherited from the host environment. A URL with no
  password marker keeps the inherited value.
- A connection string that is not a `postgres://`/`postgresql://` URL, or that
  sets `sslpassword` (libpq has no environment variable for it), is refused
  before `pg_dump` is spawned and before any staging file exists. The message is
  fixed text that never echoes the string. Behaviour change: with
  `backupEngine: "auto"` the refusal falls back to the JavaScript exporter; with
  an explicit `"pg_dump"` engine it is a new failure; under preserve-all it fails
  with the fixed hint in the error.
- Captured stderr is redacted of every password found in the URL, decoded and
  encoded. Preserve-all errors never include stderr, a cause or the connection
  string.
- The child process is spawned with `windowsHide: true` so scheduled backups do
  not flash a console window on Windows.

Known limit, tracked separately: database restore (`restoreWithPsql` in
`backup-lib.ts`) still passes the connection string, including any password, to
`psql` on the command line. This change does not alter the restore path other
than hiding its console window.

## Output publication contract

1. Reject an already-existing final name, including a dangling link, before
   opening staging output or spawning the child.
2. Open random, same-directory staging output with `wx`. Its name ends in
   `.partial-<random UUID>`, not `.sql.gz`; health therefore does not admit it.
3. Wait for both the child result and gzip pipeline. Sync and close the single
   FileHandle-owned writer before publication.
4. Use `fs.link` to publish the final name without replacing an existing entry.
   A collision or unsupported operation fails closed. Do not substitute rename,
   copy-with-cleanup, JavaScript export, pruning, or unlink.
5. Retain both names on success and staging output on failure. These are two
   names for one inode, **not** two independent recovery copies.

### After preserve-all is turned off

Each preserved dump leaves a second hard link `<name>.sql.gz.partial-<uuid>` to
the same inode. The legacy retention pruner used to match only `.sql` and
`.sql.gz`, so after the flag was turned off it would delete the old `.sql.gz`
names while the `.partial-*` links kept every inode (and its disk blocks) alive.
`pruneOldBackups` now removes a pruned backup's `.partial-<uuid>` links together
with it. A `.partial-<uuid>` file whose backup name does not exist (failed
staging output) never competes for a daily/weekly/monthly slot and is deleted
only once it is older than every retention tier. Names that do not end in a UUID
are never touched. While preserve-all is on nothing is pruned, so disk growth is
bounded only by the capacity owner's policy below.

Strict failures expose a bounded phase/code and, when owned staging was created,
its basename. Raw child stderr, connection strings, paths from underlying
exceptions, and exception causes are not attached to the public error.

The directory must be owned and trusted. Path-based publication is not a claim
of resistance to hostile directory swaps. Windows mode `0o600` is not an ACL
privacy guarantee. Filesystem support must be qualified on the selected output
filesystem; source availability or documentation alone does not establish it.

## Checks actually run

### Current receipts (2026-11-18, PR head after the review-fix commit)

Recomputed from the real files, not carried over from the first commit. Node
24.18.0, Vitest 4.1.10, `@paperclipai/db` workspace, no database or native
PostgreSQL client contacted; child processes are mocked, fixture filesystem
operations, streams, gzip and hard links are real.

- `server/src/index.ts` SHA-256
  `4f5f3798b13a53ce437182c868c095235577de0aa0bca3aeba45db86ad6200f9`;
  `server/src/__tests__/instance-database-backups-routes.test.ts` SHA-256
  `e81816d655fcfd9415ccb03c611ea2872c79a4c9240f574b73b6d064f8cdb596`. Neither
  file is changed by the review-fix commit, so these also describe the previous
  head.
- `packages/db/src/backup-cli.test.ts`: 55/55 passed.
  `packages/db/src/backup-prune.test.ts` (new): 5/5 passed. Together 60/60.
- `pnpm run typecheck` for `@paperclipai/db` (migration checks plus
  `tsc --noEmit`) passed.
- Negative controls, each attributed to the intended cause and then restored:
  - Pruner reverted to the previous code (only `export` added so the new test can
    import it): 3 of the 5 prune tests failed (partial link left behind after its
    backup was pruned; the same inside a week bucket; orphan handling) and the
    other 57 passed. Restored: 60/60.
  - `backup-cli.ts` reverted to the previous code: 8 tests failed (query-over-userinfo
    precedence with `windowsHide`, the last-query-password case, four
    empty-password cases, and the two preserve-all refusal-hint cases) and 52
    passed. Restored: 60/60.
- The server route suite (`instance-database-backups-routes.test.ts`) was not
  re-run locally in this round (only the database workspace was installed in the
  isolated worktree); it runs in the pull request workflow. Its source is
  unchanged since the earlier 20/20 local run.
- Not run: `backup-lib.test.ts` (embedded PostgreSQL), as before. The new pruner
  behaviour is covered by the filesystem-only `backup-prune.test.ts` instead.

Scope of the cases added in this round: `password=` precedence over `user:pass@`
(last query pair wins); explicit empty password versus an inherited `PGPASSWORD`;
a URL without any password keeps the inherited value; `spawn` options include
`windowsHide: true`; refusal of `sslpassword` and of non-URL strings reports a
fixed hint under preserve-all, before any staging file or spawn; pruning removes a
pruned backup's `.partial-<uuid>` links, keeps those of retained backups, treats
orphaned partials separately, and leaves other prefixes and look-alike names alone.

### Original qualification run (historical: first commit 54b0eb55, 2026-10-04)

The counts, hashes and measurements in this subsection and in the two that follow
describe the first commit of this candidate only. They are kept as history and
are **not** receipts for the current head; the current receipts are above.

Node 24.18.0, Vitest 4.1.10, one worker, file parallelism disabled. Existing local
dependencies were reused. Captures, cache and child temp variables were isolated;
no database or native PostgreSQL client was contacted. Child processes are mocked;
fixture filesystem operations, streams, gzip and links are real.

- 29/29 cases passed on the C: fixture filesystem (historical; the helper suite has
  since grown).
- One selected complete-publication case passed on the ReFS source volume;
  the other 28 were intentionally not selected for this conformance run.
- Targeted TypeScript checking of the helper and its test passed. This is not
  full-workspace type checking or the normal commit/push gate.
- A private copied helper with pipeline-failure rejection deliberately disabled
  failed its assertion with exit 1, for the expected resolved-instead-of-rejected
  reason. The unmodified copied helper passed with exit 0. Candidate source was
  never changed by that negative control.
- Completed test/check runs had healthy complete captures and proved zero owned
  processes remaining. The first private negative harness attempt failed before
  tests on an inherited missing adapter tsconfig; that is not negative proof.
  An isolated harness tsconfig corrected the fixture boundary.

Cases cover dual rejection, child error precedence, gzip integrity, writer close
before publication, historical bytes retained, two-name/inode identity, early and
racing final collisions, unsupported publication, child/stream failure, constructor
and sync/stat/close failures, sanitized errors, no JavaScript fallback, invalid
policy options, buffered SQL lines, and legacy auto/retention response regression.
The existing server health function is called directly: complete final output is
admitted, while retained failed/unsupported-publication staging is not admitted.

### Actual caller source projection (historical: first commit)

The existing server route fixture was extended rather than starting a server or
inventing a replacement backup controller. It parses the owned `index.ts` with
the existing TypeScript compiler API, restricts selection to `startServer`'s
direct runner and `let` mutex declaration, and extracts the real awaited
`createApp` manual adapter. Only those arrow bodies execute, with synthetic
dependencies. The existing enabled branch's direct scheduled interval is checked
for its binding to the same caller; no interval is installed.

- 17/17 route/caller cases passed against the final source. They cover existing
  authorization/cloud floors, anonymous and managed-config-only rejection,
  exact strict native options, request-override refusal, preserved result fields,
  shared manual/scheduled exclusion, and mutex release after both settings and
  native-runner failure.
- A credential-like synthetic failure produces exactly the generic HTTP 500
  response. This is response redaction, not log or telemetry privacy proof.
- Targeted strict TypeScript checking of the test and its imported graph passed
  with the existing Express request augmentation included. An initial invocation
  omitted that declaration and failed on missing `Request.actor`; it is retained
  as a harness failure, not a product defect or positive qualification.
- Both in-memory policy mutants exercise the same strict-policy assertion and
  fail for the named missing option. Additionally, the actual selected Vitest
  caller test failed with exit 1 on a private source copy missing `preserveAll`,
  specifically `preserveAll must prevent deletion/fallback`; the unmodified copy
  passed with exit 0. Copied source uses normalized LF; actual candidate bytes
  were unchanged during this deliberate negative run.
- Final caller run: 4,054 ms, peak job memory 670.0 MiB, exit 0. Final test typing:
  5,820 ms, exit 0. Negative/restored: 3,716/3,829 ms, exit 1/0. All had complete,
  healthy stdout/stderr captures and zero owned processes remaining.
  The unchanged helper's 29 cases were rerun with the five-file candidate pins
  and passed in 1,060 ms. These five final receipts also record the exact private
  runner/config hashes and invocation; no explicit capture-thread join field is
  present, so no stronger thread-join claim is made.

The source-projection selector and shared assertion were tightened after an
independent reviewer found possible false-positive bindings and weak mutant
checks. The corrected final two-file source review has no further actionable
finding within this declared scope. It is advisory, not installed acceptance.

Historical receipts of the first commit only (superseded; the files have changed
since, see the current receipts above): server SHA-256
`c2a3b9d77554ec72b328e0ce43084cfe6bc68cb893d3c35bd9b0e589ede46e53`, route-test
SHA-256 `96a103f9cbf36524d96dd6761bfc61df323a502593c1ff32f0d8f0e5d26f9bc6`.

### Size exception and reduction review

The pre-existing server entrypoint is oversized. At the current head
`server/src/index.ts` is 2,031 physical / 1,923 nonblank lines against 2,027 / 1,919
on the PR base: exactly four added lines (a two-line comment, one flag constant and
one conditional spread on the existing shared backup call). The existing route test
is 435 physical / 395 nonblank lines, below the 700-line test target. In
`packages/db`, `backup-cli.ts` (the new shared helper) is 319 lines and
`backup-lib.ts` is 1,134 lines (1,133 on the PR base), above the 500-line production
target but already oversized before this PR. This round adds a separate
`prunePartialLinks` helper of about 25 lines plus a few lines in `pruneOldBackups`
rather than growing the pruner inline. The earlier first-commit figures (1,438 to 1,440 nonblank
lines, two added lines) are historical.

An untested controller extraction would expand this recovery theme; importing
the whole entrypoint for tests would risk startup side effects. The chosen
alternative preserves the existing call boundary and reuses the existing fixture.
A separate entrypoint reduction remains an open follow-up; this exception is not
permission to grow the entrypoint further.

An initial legacy regression fixture used an old filename but a current filesystem
mtime. Its retention expectation failed; assigning an old mtime to that newly
created synthetic fixture corrected the test. No production retention code was
changed to accommodate the fixture.

Independent source review caught a raw-descriptor double-close race and a
constructor-failure handle leak. Both were corrected before successful
qualification by using `FileHandle.createWriteStream` inside the protected
try/finally. The proposal follows the exact
[Node v24.18.0 stream ownership implementation](https://raw.githubusercontent.com/nodejs/node/v24.18.0/lib/internal/fs/streams.js)
and [coordinated FileHandle close implementation](https://raw.githubusercontent.com/nodejs/node/v24.18.0/lib/internal/fs/promises.js).

## Remaining gates and owners

- CTO: helper contract accepted; review the exact changed server/test bytes and
  final source receipts separately. Installed adoption remains unapproved.
- Author and reviewer: normal, unbypassed commit/push gates and an exact-head PR.
  Publication is not installed adoption; do not merge a known-red candidate.
  The existing push hook permanently removes its protocol artifact and has no
  qualified retention adapter; the actual hook dispatcher also remains unbound.
  These are publication prerequisites, not permission to skip hooks or broaden
  synthetic-fixture cleanup consent. Full-workspace gates remain outstanding.
- Runtime/recovery owner: identify and qualify the actual backup output filesystem,
  configured engine/client, serialized manual/scheduled behavior, and privacy-safe
  installed error handling before a bounded native run.
- Recovery owner: obtain a verified fresh database dump and demonstrate isolated
  restore including assets/key metadata and separately verified authentication
  reseed. Auth-pointer/hardlink rules for credentials are a separate contract.
- Lifecycle owner: bound child execution and descendant cleanup independently.
  `allSettled` is not a deadline; a hung child can hold the backup mutex.
- Health owner: the existing scanner still trusts suffix/mtime for legacy files.
  This candidate prevents incomplete strict output from acquiring that suffix; it
  does not validate every historical `.sql.gz` file or prove restore readiness.
- Capacity owner: preserve-all avoids pruning but needs an explicit disk-growth
  policy and recovery-safe operator disposition, not automatic deletion.

No live backup, restore, installation, upgrade, credentials, service restart,
backup scheduler setting, or broad sync was changed during these source checks.

## Primary reference limits

[PostgreSQL pg_dump documentation](https://www.postgresql.org/docs/18/app-pgdump.html)
requires a client sufficiently new for the server. A normalized single-database
dump is not full-cluster disaster recovery; restore can execute untrusted SQL.

[Node filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html)
defines exclusive-open and hardlink behavior. Microsoft documentation has
version-dependent ReFS statements:
[ReFS overview](https://learn.microsoft.com/en-us/windows-server/storage/refs/refs-overview)
and [CreateHardLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw).
The observed synthetic conformance result is limited to this tested host/volume.
