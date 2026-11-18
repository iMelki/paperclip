# GitHub Project standing schedule grants

Paperclip can grant the native GitHub Project board scheduler revocable standing
authorization for one company and project. The grant is import-only and does not
dispatch agents. It does not grant permission to write to GitHub.

To opt in, an authenticated company member creates a schedule grant with an
explicit `expiresAt: null`. A timestamp continues to create a version 1 grant
whose duration is at most 24 hours. Existing version 1 grants are not converted
automatically. Replacing a grant uses its expected revision; revocation uses the
same revision check and records the action.

Standing grants still require an active authorized member, matching board and
GitHub connection, a valid credential and the native scheduler job. The host
rechecks these requirements when it runs and commits an import. A separate,
finite execution lease and run deadline remain in force.

For rollback compatibility, a version 2 grant is stored with a disabled version
1 marker. An older host sees the disabled marker and does not run the standing
grant. Any mismatch between marker and grant requires explicit reconciliation;
it must not silently resume an older authorization.

This document describes source behavior. Installation, a live standing grant,
scheduled execution, and duplicate-free live replay require separate evidence.
