# Private GitHub board import and OAuth qualification checkpoint

Owner: Paperclip integration conversation. Date: 2026-10-12. Tracking context:
Paperclip #126/#129, recovery #125, Windows lifecycle #35/#33. No public writes
are approved; source, registration and rollout remain separate.

Current continuation: [dedicated read/write OAuth connector qualification](github-oauth-workspace-20261013.md).
The dated OAuth section below describes the earlier import pilot and compatibility
snapshot. Import-only is not the permanent product policy; the operator now
requests repository, issue and Projects read/write with separate action approvals.

## Requested acceptance

Existing Asimtop/MemSys and GitHub personal Project #12; native Connect GitHub
consent, finite manual import twice, stable task/membership IDs, no unintended
assignment or wake/run. This installed result is NOT complete.

## Source implementation and review

Native import service uses existing schema and PostgreSQL transactions/savepoints,
immutable identities, operation-intent/journal storage, advisory source/node
locks and a durable manual subtree hold. It does not emit issue-created events
or request agent dispatch. Title refresh uses an explicit publication collector.
Native readback derives hold status, not a worker-provided noDispatch assertion.

The SDK requires trusted host invocation company and concrete signed-in user
for import operations. Stock exclusions are company-scoped reads. Capability
checks cannot emulate an absent native host implementation. Generic state cannot
alter the reserved native journal. Stock SDK creation shares a canonical URL
lock. Generic updates recognize protected origins across ALL plugin keys.

Independent static review found and the parent repaired the second-plugin update
bypass. The real SDK-handler/native-boundary suite then passed21/21, including
negative mutation cases, positive unrelated-task behavior, protected journal
aliases, malformed origin IDs and case-varied stock duplicates. This is not a
worker-process RPC or installed-source proof.

## Retained qualification runs

| Capture stem (private validation directory) | Outcome | Duration ms | Peak Job bytes |
| --- | --- | ---: | ---: |
| sdk-20261012-194056-2e073115eca8463b9bb8709e17b464cd | SDK34/34; exit0 | 2032 | 230834176 |
| native-20261012-201019-a0e2f33cee94475fac6a0577a91e93cb | Native23/23; exit0 | 33969 | 770392064 |
| boundary-20261012-201758-653d0d61d9394d8188892d36a2d7fc82 | Native host21/21; exit0 | 35078 | 918990848 |
| oauth-20261012-202037-0bec2ef40aba4833910f218c980ce1d5 | Deliberate JSON Accept removal;42pass/1fail;exit1 | 10670 | 808960000 |
| oauth-20261012-202111-038836f884074802a1100027e70cd6c5 | Exact restoration;43/43;exit0 | 9110 | 792612864 |

Every admitted run used pinned Node24.21, cleared credential environments,
windowless NativeJob custody, deadlines/capture/memory caps and final zero-active
member readback. Full raw captures and private runner/config paths remain in the
owning conversation checkpoint, not a public artifact.

Native clusters `pg-Sex5ko` and `pg-CwQr5D` are synthetic private fixtures;
their data/logs were retained. Exact-cluster shutdown, `pg_ctl status` exit3,
postmaster PID-file absence and outer zero-active-member proof are required.
The helper SHA is2CD7B9EEE0D01E9B69BCF123CF09904C5D243A052B642D5516509497140CCC48.
It fixes Windows command-processor initialization, literal single-quote socket
values and inherited-pipe false timeouts without patching vendor/runtime files.

The boundary resolver preserves production-lazy optional OTEL exporter imports;
no exporter is configured in its cleared environment and instrumentation is
not mocked. Optional telemetry paths are not qualified by these cases.

## OAuth research and compatibility repair

Reuse native state/PKCE, company/operator/session binding, encrypted secret
references, refresh handling and canonical configured callback. The current
GitHub catalog is PAT/MCP only; it is NOT already a one-click OAuth connection.
No existing registration/client-ID metadata was established (unknown, not absent).

Source repair requests JSON; parses comma scopes only for exact GitHub token URL;
rejects HTTP200 OAuth errors and blank tokens; recognizes exact GitHub refresh
bad_refresh_token as reconnect-required. Generic scope dialect remains unchanged,
while JSON Accept/error rejection intentionally affect all providers.

Non-author source approval at20:21:50Z:

- Service SHA3873F32AF399231BE5FB5374B5624757AB97D7DEFEC0ACD20266083E0C46656A.
- Test SHAA9AA1F7149AB878B619CAD974663E58F2292076DD01B73F669B59B4D17937876.

The attributable negative failure was oauth_access_token_missing in the one
GitHub-shaped JSON-response case, not an unrelated test failure. An earlier
allocation failure is retained as inconclusive, never counted as negative proof.

Official contracts: [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[exchange/refresh](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[personal Projects API](https://docs.github.com/en/rest/projects/projects?apiVersion=2026-03-10#get-project-for-user).

Private repository OAuth repo permission includes writes; read:project covers
board reads. Enforce fixed server-side reads and do not grant general agent tools
or enable import/schedules when connecting. The actual definition, Connect UI,
GitHub identity/capability readback and server-only plugin bridge remain open.

## Issues encountered and status

- Windows fixture initialization crashed without ComSpec; adding only that OS
  metadata allowed initdb to succeed. No broader environment inheritance.
- Unix-style empty socket quotes reached Windows literally; repaired and retested.
- Descendant-held pipes delayed root completion; durable files/root-exit receipt
  repaired and native retested. Failed fixtures stayed preserved.
- Boundary import analysis encountered absent optional OTEL peers; preserve only
  the documented lazy imports rather than mock guard/database services.
- The original OAuth parser missed JSON negotiation/CSV scopes/HTTP200 errors;
  repaired and43casesqualified. Independent refresh finding also repaired.
- A typecheck hit its allocation/deadline budget; lower Go GC/concurrency targets
  qualified the plugin without widening its 1GiB process cap.
- A90.1498% RAM admission deferred a build without starting a child; later admitted
  plugin compile passed. No unrelated processes were stopped.

## Remaining owners and gates

Parent owns integration; non-author Reviewer/CTO owns exact-head acceptance and
runtime custody. Live serving checkout is unchanged. Full host typecheck/normal
hooks and actual worker RPC are pending. A paired patched SDK/plugin artifact is
required: published SDK2026.831.1 has no native importedBoard worker method.
No migration was added by this source change.

Before installation: pinned private closure, full checks, recovery/restore,
artifact provenance/rollback and coordinated exact-version adoption. Before live
imports: ASI-owned authenticated Project capability, existing destination mapping,
stock/recovery exclusion proof and actual before/after run/event baselines.

Current Next15 is maintained in the paired plugin's
`docs/validation/project-board-sync.md`; OAuth wizard and credential bridge lead
that queue. No token was read/saved, GitHub registration/consent performed,
plugin installed, app restarted or real board imported in this continuation.
