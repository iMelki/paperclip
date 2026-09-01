# 2026-09-01 delivery maintainability receipt

Scope: the combined Paperclip #47, #63, #80, #84, #87, and #88 delivery.
This receipt records the final working-tree bytes before the real commit hook.

## Counting method

- Physical lines are `System.IO.File.ReadAllLines(...).Count`.
- Source lines are physical lines with blank lines removed; comments remain
  source because they are maintained by humans.
- The decision proxy counts explicit branch/control decisions in the named
  function. Maximum nesting is an inspection proxy, not a cyclomatic-complexity
  claim.
- Generated, vendored, declarative, and human-authored files are classified
  separately. No PowerShell source changed in this delivery.

## Human-authored source and test inventory

| Path | Before physical/source | After physical/source |
| --- | ---: | ---: |
| `.github/scripts/run-quality-gates.mjs` | 148/126 | 150/128 |
| `.github/scripts/tests/run-quality-gates.test.mjs` | 43/39 | 64/55 |
| `packages/adapter-utils/scripts/ssh-command-lookup-gate.mjs` | 0/0 | 220/204 |
| `packages/adapter-utils/src/command-path.test.ts` | 0/0 | 241/212 |
| `packages/adapter-utils/src/command-path.ts` | 0/0 | 109/98 |
| `packages/adapter-utils/src/server-utils.ts` | 3,533/3,265 | 3,489/3,227 |
| `packages/adapter-utils/src/ssh-command-lookup-ratchet.test.ts` | 0/0 | 78/66 |
| `packages/adapter-utils/src/ssh.ts` | 1,873/1,731 | 1,860/1,719 |
| `packages/adapter-utils/test-fixtures/passive-ssh-command-description.ts.txt` | 0/0 | 6/5 |
| `packages/adapter-utils/test-fixtures/unsafe-import-aliased-ssh-command-lookup.ts.txt` | 0/0 | 5/4 |
| `packages/adapter-utils/test-fixtures/unsafe-ssh-command-lookup.ts.txt` | 0/0 | 7/6 |
| `packages/adapter-utils/test-fixtures/unsafe-zsh-which-command-lookup.ts.txt` | 0/0 | 7/5 |
| `scripts/generate-pr45-disposition-manifest.mjs` | 0/0 | 513/488 |
| `scripts/generate-pr45-disposition-manifest.test.mjs` | 0/0 | 82/76 |
| `scripts/lib/pr45-disposition-policy.mjs` | 0/0 | 131/126 |
| `scripts/lib/unified-zero-patch.mjs` | 0/0 | 70/65 |
| `server/src/__tests__/agents-pending-approval-config.test.ts` | 159/146 | 639/601 |
| `server/src/__tests__/approval-routes-idempotency.test.ts` | 449/407 | 561/513 |
| `server/src/__tests__/approvals-service.test.ts` | 169/140 | 640/573 |
| `server/src/__tests__/error-handler.test.ts` | 124/107 | 147/127 |
| `server/src/__tests__/hire-approval-payload.test.ts` | 0/0 | 241/225 |
| `server/src/__tests__/http-log-redaction.test.ts` | 86/79 | 170/159 |
| `server/src/__tests__/redact-sensitive.test.ts` | 100/80 | 145/121 |
| `server/src/middleware/error-handler.ts` | 148/136 | 176/161 |
| `server/src/middleware/http-logger.ts` | 0/0 | 55/52 |
| `server/src/middleware/logger.ts` | 97/89 | 48/40 |
| `server/src/middleware/redact-sensitive.ts` | 100/94 | 108/102 |
| `server/src/routes/agents.ts` | 4,114/3,782 | 4,116/3,784 |
| `server/src/routes/approvals.ts` | 535/493 | 541/499 |
| `server/src/services/approvals.ts` | 314/288 | 471/437 |
| `server/src/services/built-in-agents.ts` | 2,026/1,909 | 2,027/1,910 |
| `server/src/services/hire-approval-payload.ts` | 0/0 | 246/228 |
| `server/src/services/plugin-managed-agents.ts` | 562/521 | 563/522 |
| `ui/src/components/OnboardingConfigurationReview.test.tsx` | 0/0 | 103/89 |
| `ui/src/components/OnboardingConfigurationReview.tsx` | 0/0 | 151/142 |
| `ui/src/components/OnboardingWizard.config-persistence.test.tsx` | 0/0 | 409/368 |
| `ui/src/components/OnboardingWizard.tsx` | 1,789/1,709 | 1,883/1,798 |
| `ui/src/hooks/useOnboardingAgentConfigReview.ts` | 0/0 | 62/58 |
| `ui/src/hooks/usePersistOnboardingAgentConfig.ts` | 0/0 | 75/69 |
| `ui/src/lib/onboarding-agent-config.test.ts` | 0/0 | 278/259 |
| `ui/src/lib/onboarding-agent-config.ts` | 0/0 | 123/110 |

## Threshold and cohesion review

| Surface | Function evidence | Decision |
| --- | --- | --- |
| Onboarding wizard | `OnboardingWizard` 1,562 to 1,645 source lines, proxy 155 to 165, depth 4; `handleGiveHeartbeat` 99 to 114, proxy 18 to 17, depth 3; new environment verifier 14, proxy 3, depth 1. | Exact-patch exception accepted. The file was already oversized, but Review, comparison policy, query review, and persistence were extracted into four leaves totaling 411 physical lines. The remaining growth is tightly coupled reset/step orchestration. Paperclip #107 owns extraction of the step-4/5 controller before more substantive growth and is due for review by 2026-10-01. |
| Returning-persistence hook | Public hook 46 source lines; nested callback 40, proxy 4, depth 1. | Cohesive prepare, effective-config verification, PATCH, and cache invalidation boundary. It avoids duplicating merge policy in the Wizard. Server-owned revision/CAS hardening is tracked in #105. |
| Agent routes | `agentRoutes` 3,619 to 3,620 source lines; hire callback 173 to 174, proxy 28 to 25, depth 4 to 3. | Exact-patch exception accepted: only one shared payload-preparation import/call grows here, while security decisions move into `hire-approval-payload.ts`. #106 blocks further unreviewed growth and is due for review before the next change or 2026-09-15. |
| Built-in agents | Factory 1,106 to 1,107 source lines; `provision` 111 to 112, proxy 17, depth 4. | Exact-patch exception accepted: one shared preparation call replaces duplicated inline payload handling. #106 owns the next reduction review. |
| Plugin-managed agents | `createManagedAgent` 80 to 81 source lines, proxy 4, depth 2. | Mandatory independent >80 review accepted the one-line central boundary call; splitting that line would add indirection without reducing decisions. #106 blocks further growth without extraction. |
| Approval service | Factory 279 to 423 source lines; `createAgentFromApprovedHire` 47, proxy 20, depth 3. | The outer factory remains a service container. Secret custody, field mapping, transaction phases, reconciliation, and post-commit notification helpers are separated enough to preserve one atomic Drizzle transaction. #106 owns a later workflow extraction. |
| Shell-free command resolver | New `resolveCommandPath` 43 source lines, proxy 18, depth 3. | Cohesive platform lookup primitive using Node built-ins only. `server-utils.ts` shrinks 44 physical lines and `ssh.ts` shrinks 13. This corrects the earlier #63 receipt's decision-proxy undercount. |
| PR #45 disposition generator | 513 physical but 488 source lines; `exactResultEvidence` 55/proxy 22/depth 4, `buildCommitRecord` 64, `buildManifest` 69, `validateManifest` 68/proxy 24/depth 4. | No >500-source file exception is required. Patch parsing and disposition policy are already extracted; keeping the orchestration together makes the 3,032-hunk custody result reproducible and conservative. |
| Error handler | `errorHandler` 64 to 65 source lines, proxy 27 to 28, depth 5. | Independent complexity review accepted the one call to the extracted structured-log sanitizer; DB-param and recursive redaction logic are outside the handler. |
| Pending-approval DB tests | File 601 source lines; largest real `it` bodies 99 and 86. | Below the 700-line test target. Describe callbacks are declarative test registration. Repeated setup stays local because each transaction/race fixture deliberately changes connection or failure boundaries; extracting one generic builder would obscure the negative control. |

## Generated evidence classification

`packages/adapter-utils/package.json` is declarative gate wiring and grows from
53 to 54 physical lines to run the SSH ratchet before `tsc`.

The operational/declarative records remain below the roughly 800-line action
band: `.gate-evidence.json` 365 to 432, `CHANGELOG.md` 350 to 421,
`CONTRIBUTING.md` 294 to 309, `OPEN_TASKS.md` 430 to 546, the new #63 receipt
JSON 217, the PR #45 summary 43, and this receipt 117 lines before the four
fixture rows and this classification were added. They remain navigable by
headings or keyed JSON entries; no current-guidance/history split is required.

`doc/evidence/pr45-disposition/2026-09-01-pr45-no-loss-disposition.json`
is generated evidence, not human-authored source. It is 82,799 lines and is
owned by `scripts/generate-pr45-disposition-manifest.mjs`. The checked-in
generator plus `--check` reproduces it; humans must not hand-edit it. The
generated file pins the four PR #45 commits and both preservation refs and does
not authorize merge, cherry-pick, branch deletion, stash mutation, or evidence
retirement.

## Validation and independent review

- #84 review-governance caller: 4/4 pass after the legacy Greptile claim failed
  for the intended reason.
- #63 command lookup and ratchet: 17/17 pass after unsafe shell fixtures failed
  for the intended reason.
- #80 disposition generator: 3/3 pass plus reproducible `--check`; stale output
  failed for the intended reason.
- #87 final focused set: 21/21 pass. Deliberately testing the Wizard draft
  instead of the effective preserved config failed 2/7 for the exact hidden
  command/cwd/env mismatch before byte restoration. The final task-owned UI
  typecheck receipt is `78a91dd920ab43468e29d0d6db65ca35`: exit 0 in
  58,047 ms, peak process/job committed memory 2,315,288,576/2,531,090,432
  bytes, and an S: free-space drop of 122,880 bytes.
- #88 final redaction set: 15/15 pass. Removing camelCase-boundary
  normalization failed 2 unit assertions and one production-pino canary before
  exact restoration. Server typecheck receipt
  `5dd4547beac74d72a719d5d6bccb47ca` exited 0 in 40,621 ms with peak
  process/job committed memory 2,407,260,160/2,624,176,128 bytes.
- Adapter-utils typecheck receipt `aa4f80c658944d089a5f749236db98ad`
  exited 0 in 5,315 ms with peak process/job committed memory
  410,644,480/648,970,240 bytes.
- The first governed UI typecheck intentionally used a smaller 1.5 GiB process
  envelope and exited 134 at that ceiling with zero surviving Job members. The
  final 2.5/4 GiB process/tree envelope passed; this is resource calibration,
  not a hidden green result.
- Real pre-commit/pre-push hooks, hosted exact-head CI, and exact-head automated
  review remain separate delivery gates at the time of this receipt.

Independent reviewer:
`Codex independent maintainability review —
paperclip_delivery_integration_review/maintainability_check, 2026-09-01`.
The exceptions above apply only to this exact patch. P0: none. P1: none.
Follow-up custody is explicit in #105, #106, and #107.
