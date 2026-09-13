# PostgreSQL owned Windows session: research, not implementation

Issue35 / PR117. Research-only sidecar inspected agent-settings293e5cd6 and
git-toolkit73dbc33f. No native launch, install, live service or elevation ran.

## Local-first candidates

| Existing primitive | Fit and gap |
| --- | --- |
| agent-settings/shared/tools/NativeJobProcess.Common.ps1 | Preferred foundation: atomic Job-list assignment, suspended/windowless launch, explicit handle inheritance and bounded zero-member cleanup. Needs retained session lifetime instead of one-shot runner deadline. |
| agent-settings/shared/tools/WindowlessProcessHost.cs | Closes kill-on-close Job when root exits; unchanged, successful pg_ctl exit would kill the database. Not a drop-in adapter. |
| git-toolkit/hooks/RepoDoctor.ProcessRunner.cs | Explicitly lacks Job binding/verified descendant cleanup; reuse reporting only. |
| Protected/elevated native hosts | Different privilege and descendant contracts; not a direct dependency. |

Do not import machine-local precompiled DLL paths or create a second private
copy of the ownership mechanism. Canonical owner review and reproducible
packaging are needed before adoption.

## Proposed lifecycle

Create and retain an opaque attempt session with Job/root handles before resume.
Atomic Job-list assignment avoids the gap between process creation and later
Job assignment. Keep Job ownership after pg_ctl successfully exits; startup
observation and database lifetime are separate. Serialize start/stop/cancellation.
Late readiness cannot turn cancelled startup into success.

On failure, terminate only the owned Job and bound the wait for zero members.
Unknown accounting means unresolved: preserve data and prevent retry. Directory,
PID file and port checks are not ownership. Graceful signal identity requires
separate review; do not replace this with stop-by-directory or substring taskkill.

## Source evidence and community context

- [PostgreSQL18.1 pg_ctl source](https://raw.githubusercontent.com/postgres/postgres/REL_18_1/src/bin/pg_ctl/pg_ctl.c)
  launches CMD; its restricted child creation does not request breakaway. Outer
  Job containment is a source-based inference, not current native proof.
- [pg_ctl manual](https://www.postgresql.org/docs/18/app-pg-ctl.html): a timed-out
  operation may later succeed; timeout is not cancellation.
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
  and [atomic Job-list creation](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)
  explain retained handles and the create/assign gap.
- [Upstream discussion](https://www.postgresql.org/message-id/CAA4eK1%2BzwF3oXMVFy8shsAEG7aGVtg8jGGfwk4Lc_5eHVUywTg@mail.gmail.com)
  questions PostgreSQL Job lifetime comments; it is not cancellation evidence.

## Required future proof

Inert descendants first: root exits while grandchild remains owned; failures
before resume; inherited-handle leak; concurrent stop; owner death; foreign PID
candidate never signalled; cleanup deadline never reports false success. Then
isolated native PostgreSQL tests with nested Jobs and continuous window observation.
The inner pg_ctl child lacks CREATE_NO_WINDOW in source, so outer windowsHide is
not full descendant proof. Native packaging, provenance, signal identity and
ordinary/elevated compatibility remain open. No production design acceptance
or lifecycle completion is claimed by this research note.
