# Cost imports, recorded spend and provider quota

Tracking: [cost import identity #114](https://github.com/iMelki/paperclip/issues/114),
[provider allowance display #115](https://github.com/iMelki/paperclip/issues/115).

## Import contract

`POST /api/companies/:companyId/cost-events` accepts three optional fields:

| Field | Meaning | Limit |
| --- | --- | --- |
| `sourceSystem` | Stable producer namespace, such as a provider export format | 128 characters |
| `sourceAccountId` | Opaque account identity in that system; never an API key | 256 characters |
| `sourceEventId` | Immutable upstream event identity within that account | 512 characters |

Supply all three or omit all three. Values are trimmed and cannot be blank.
The unique key is `(companyId, sourceSystem, sourceAccountId, sourceEventId)`.
Different companies, systems and accounts can legitimately reuse an event ID.
Existing company authorization and own-agent reporting restrictions still apply.

- A new event returns **201** and its stored `CostEvent`.
- An identical normalized replay returns **200** and the same event, including
  its original `id` and `createdAt`.
- Reusing an identity with changed cost, tokens, model, provider, biller,
  billing status, occurrence time, or task attribution returns **409**. The
  original row is never overwritten.
- A partial identity is rejected by the request validator; a database check
  also rejects partial identities from direct writers.
- Legacy reports with no identity remain append-only. No heuristic dedupe is
  applied to identical-looking usage or historical rows.

Defaults and nullable attribution are normalized before comparison. The event
time is compared as an instant, not as a timestamp's spelling. Importers must
reuse the original occurrence time when replaying; import time belongs in
import-run evidence, not `occurredAt`. Corrections require a deliberate separate
event and a reviewed correction contract; sending changed content under an old
identity is not a correction mechanism.

`costService.createEvent()` retains its event-only return shape.
`createEventWithOutcome()` adds `{ event, created }` for callers such as the API.
The route records `cost.reported` only for newly created rows.

## Transaction and budget behavior

The service locks the company row, inserts or resolves the source event, and
updates company/agent monthly totals in one database transaction. The database
unique index also protects direct inserts and concurrent imports. Replays do
not add spend or repeat the route's cost audit event.

Budget policies remain company, agent or project policies. Budget pauses and
incidents are evaluated in the transaction. Cancellation hooks run after commit
so live work sees the committed pause. A replay reevaluates enforcement and
retries cancellation after a hook failure; hooks must tolerate repeated
cancellation of the same scope. Budget incidents deduplicate by policy, period
and threshold. This is retry recovery, not a background delivery outbox: the
caller must retry a failed request. A failure after commit means the cost may
already be recorded; stable source identity makes that retry safe.

## UI meaning

Provider and biller cards show recorded costs and **Unallocated** budgets.
Company budget does not imply a provider allowance. The old proportional
allocation made all providers show the company utilization percentage, and
dividing that allowance by 4.33 invented a weekly limit. Both calculations and
their projected-deficit treatment have been removed.

Company budget utilization remains a company metric. Provider-reported quota
windows remain separate from recorded spend. Their reset timestamps and source
semantics are unchanged. Rolling spend bars compare observed windows; they are
not quota or remaining-budget percentages. These fixes reuse the app's existing
card and quota components and introduce no UI dependency.

## Migration and remaining work

Migration `0214_sticky_argent.sql` adds three nullable columns, one unique index
and one completeness check. Existing rows remain valid with null source fields.
Generation used the documented `pnpm db:generate` command, then scoped generated
SQL and snapshot to `cost_events`: the previous snapshot also wanted to recreate
unrelated coordination/cloud tables. That historical drift is tracked in
[#116](https://github.com/iMelki/paperclip/issues/116). No deployed migration was
rewritten and no live database migration ran for this change.

The heartbeat producer still increments `agentRuntimeState` before its legacy
cost insert and uses a new occurrence time on each call. Its future conversion
needs a stable completion timestamp and one replay-aware accounting boundary.
It remains tracked in #114. Do not infer that this API change deduplicates all
legacy producers or reconciles provider invoices. Global usage-ledger ownership
is independent; this path makes no new cross-service call.

Implementation uses PostgreSQL's unique-index conflict handling and Drizzle's
transaction API. References: [PostgreSQL INSERT](https://www.postgresql.org/docs/17/sql-insert.html),
[Drizzle inserts](https://orm.drizzle.team/docs/insert),
[Drizzle transactions](https://orm.drizzle.team/docs/transactions).

Validation evidence: [2026-09-07 receipt](evidence/cost-source-identity/2026-09-07.md).
