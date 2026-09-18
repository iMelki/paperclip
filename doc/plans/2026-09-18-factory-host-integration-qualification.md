# Factory host integration qualification

Owner: host integration lane. Tracking: [#129](https://github.com/iMelki/paperclip/issues/129).
Status: candidate only; not approved for deployment or live migrations.

## Exact inputs

- Fork base: `79648a3a3c8b6a1165eb9586f1af40114af06bb5`.
- Upstream `v2026.831.1`: `65ec059bde30d98c92165b24a30a540800dd1f6f`.
- Private Windows Node: `24.21.0`; official ZIP SHA-256
  `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541`.
- Host package manager: pinned pnpm `9.15.4`, private cache.
- Secured plugin source: `2cff6ee7414ea6dcd4a8982aa5974781d213ce01`.
  Plugin archive SHA-256:
  `c437978b050cf5af2faa2377802a20c781a41116a218b496408de60b27f79d64`.

No live Factory restart, plugin install, credential read, or broad sync is part
of this source integration. No global Node or package-manager selection changed.

## Merge decisions

The upstream upgrade is broad, not a plugin-only update. Preserve the fork's
company-scoped secret contract, credential validation, coordination and cost
schema, process ownership, and Windows process-tree safety. Remove duplicated
supervisor helpers from the merge, not the ownership checks. Adapt dependency
recovery to the upstream blocked-cycle key contract.

Retain deployed fork migrations 0212–0214 and their journal entries unchanged.
Relocate the 19 upstream migrations 0212–0230 to 0215–0233 without changing SQL
bytes. Assign increasing journal timestamps after the deployed fork's 0214;
older timestamps can be skipped by the legacy timestamp migration fallback.
Regenerate the final combined snapshot. Do not retain the generated duplicate
SQL that would recreate already-applied upstream/fork changes.

## Reproduced Windows defects

1. **Lost shell fallback:** the merge lost the installed Git Bash fallback.
   A focused regression failed before restoration and passed afterward.
2. **False stopped state:** runtime shutdown omitted trusted-child/creation-time
   arguments. The supervisor refused the kill, but the caller removed registry
   state while HTTP remained reachable after five seconds. Restore the arguments
   and require `confirmedStopped` at all five shutdown call sites. Keep the
   durable registry when ownership or termination cannot be proved.
3. **Native path length:** the PostgreSQL extension SQL exists but fails with
   SQLSTATE `58P01` at a 261-character installed path. A shorter isolated source
   copy with the same dependency and file hash loads it successfully. Use a
   short validation root; do not disable security or change global Windows
   registry settings. Extension SQL SHA-256:
   `98763d59a6e221dd1bfc43e941024e4ed363fc05c9ce4514bc93554dfd8a8ed5`.
   Microsoft documents that removal of traditional path limits requires both
   application opt-in and system configuration:
   [Windows path limits](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation).

## Evidence and remaining validation

- Direct shared, SDK, DB, server, and UI TypeScript compilation passed. This is not
  a full recursive build or proof of the Rust runner build.
- Combined migration snapshot drift test: 1 passed.
- Focused fork runtime regression suite after shutdown repair: 11 passed,
  5 POSIX-only cases skipped on Windows; 40.61 seconds.
- Original long-path DB suite: 84 passed, 37 failed, 3 skipped. Most failures
  were extension setup. The Windows process-tree test exposed a 1.5-second
  taskkill timeout shorter than observed Windows startup latency. Raising the
  bounded cap to 3 seconds and fixture reap budget to 15 seconds gave 7/7 passes;
  the live case took 13.720 seconds. Confirmation still requires a fresh snapshot.
- Original secret/tool-access suite could not qualify database-backed cases
  because extension setup failed. Skipped cases are not passing validation.
- The short-root full DB suite includes the
  existing synthetic logical backup/restore test. It does not prove recovery
  of the live Factory or its key material. The process-tree helper and test were
  accidentally copied during this run, so it is a mixed-source diagnostic run,
  not an immutable final qualification receipt. Rerun against a frozen candidate.
- Windows stale-registry-PID assertions are restored; do not accept an
  unverified portless process. Upstream renamed several other tests while
  retaining their starting-row and additional-workspace assertions.
- Short-root company-secret/tool-access tests: 140 passed, 5 failed, no skips.
  The secret-handler suite passed. Remaining failures exposed lost upstream
  cross-company concealment guards and Zod 4 PATCH defaults injecting empty
  transport configuration and credential references. Repair and rerun these
  before calling the candidate qualified; do not weaken test expectations.
  This matches Zod's documented change that defaults apply inside optional
  fields: [Zod 4 migration guide](https://zod.dev/v4/changelog#defaults-applied-within-optional-fields).
  Preserve create defaults but do not synthesize absent PATCH keys.
- Restored 26 upstream resource-concealment checks and OAuth company checking.
  Repaired all six tool-access PATCH schemas. Targeted failing routes now pass
  5/5; validator suite passes 38/38. Full tool-access rerun remains pending.

## Separate delivery gates

1. Finish DB/migration, company isolation, secret, and plugin SDK/API tests.
2. Finish recursive typecheck/build, relevant host suites, and upstream privacy
   review. Do not treat a successful targeted compile as full qualification.
3. Independently review this exact candidate and required CI.
4. Complete governed live backup, restore demonstration, and capacity proof.
5. Qualify private-runtime adapter commands and the exact source provenance pin.
6. Only then perform the controlled live restart and install the exact plugin.
7. Under [#126](https://github.com/iMelki/paperclip/issues/126), prove one
   allowlisted import twice with stable identity and no agent dispatch/GitHub
   write. Project scope alone is not a repository or item-count limit.
8. Decide broader sync and GitHub Projects permissions separately.

Related source-only reviews: agent-settings PR #1137 (private runtime), plugin
PR #4 (portable build test), plugin PR #5 (import-contract characterization),
and host PR #132 (task-index repair). These are not deployment receipts.
