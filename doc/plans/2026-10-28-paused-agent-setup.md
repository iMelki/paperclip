# Paused, unconfigured agent setup

Date: 2026-10-28. Source implementation; execution and installed adoption must be verified separately.

The board can request pausedSetup on an ordinary agent hire. The request must use the existing process adapter with no executable, model, environment, secret, instructions or skill configuration. The server rejects conflicting setup fields before preparing those resources. It persists a marked inert configuration with timer and all on-demand wake aliases disabled, no creation/skill/task-assignment permission and no default task-assignment grant.

Company hire approval remains required. Paused snapshots explicitly retain false permissions and a null execution environment. Both pending and standalone setup payloads are clamped before secret normalization so unused executable settings cannot provision bindings. Without a pending approval the initial saved state is paused; with approval it remains pending_approval and approval preserves paused state and inert fields, including the payload-free approval path. This setup does not authorize provider routing or activation. Later configuration, permissions and activation are separate operator actions.


Stored false permission flags do not override the product's default-open skill policy. Verify the saved seat's paused status, absent execution configuration and API keys, and disabled wakes; do not infer those outcomes from permission flags alone.

The board-management-only company agent-census endpoint returns fixed identity columns (id, companyId, name, role, status, reportsTo), includes terminated and pending hires, and never selects adapter/runtime configuration or secrets. Use a fresh complete census to prevent a duplicate before submitting a setup request. Unsupported query parameters are rejected.

The New Agent screen offers a paused/unconfigured option. A submitted attempt is locked to its original company, settings and idempotency key; retries submit that same attempt. A paused attempt disables the runtime Test action. A saved seat is not a working provider route. Verify the actual ID, company, manager, paused state, disabled wakes and absence of runs before handing it over.

Focused tests: packages/shared/src/agent-paused-setup.test.ts and ui/src/lib/new-agent-hire-payload.test.ts. The separate server/src/__tests__/paused-agent-setup.test.ts uses the existing embedded PostgreSQL fixture and must only run through a route qualified for that descendant tree. Unit, integration, browser and live proof are distinct.

On the reviewed Linux source snapshot, 49 focused cases (18 shared, 4 UI payload and 27 approval), 91 HTTP route cases and 25 real PostgreSQL cases passed with no failures or skips. The corrected shared assertion also passed its affected 18-case rerun; that rerun does not add distinct cases. Normal shared/server/UI strict checks and a production UI build passed on that source snapshot. Exact r2 target checks, installed adoption, saved CFO and GitHub integration proof remain pending.
