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
| `packages/adapter-utils/src/remote-managed-runtime.test.ts` | 186/169 | 233/211 |
| `packages/adapter-utils/src/remote-managed-runtime.ts` | 239/223 | 236/221 |
| `packages/adapter-utils/src/server-utils.ts` | 3,533/3,265 | 3,489/3,227 |
| `packages/adapter-utils/src/ssh-fixture.test.ts` | 781/679 | 769/667 |
| `packages/adapter-utils/src/ssh-security.test.ts` | 0/0 | 65/60 |
| `packages/adapter-utils/src/ssh-command-lookup-ratchet.test.ts` | 0/0 | 90/78 |
| `packages/adapter-utils/src/ssh.ts` | 1,873/1,731 | 1,871/1,727 |
| `packages/adapter-utils/src/codex-local-execute.test.ts` | 1,525/1,438 | 1,527/1,440 |
| `tests/fixtures/ssh-command-lookup/passive-ssh-command-description.ts.txt` | 0/0 | 6/5 |
| `tests/fixtures/ssh-command-lookup/unsafe-import-aliased-ssh-command-lookup.ts.txt` | 0/0 | 5/4 |
| `tests/fixtures/ssh-command-lookup/unsafe-ssh-command-lookup.ts.txt` | 0/0 | 7/6 |
| `tests/fixtures/ssh-command-lookup/unsafe-zsh-which-command-lookup.ts.txt` | 0/0 | 7/5 |
| `scripts/generate-pr45-disposition-manifest.mjs` | 0/0 | 553/527 |
| `scripts/generate-pr45-disposition-manifest.test.mjs` | 0/0 | 121/111 |
| `scripts/lib/pr45-disposition-policy.mjs` | 0/0 | 131/126 |
| `scripts/lib/unified-zero-patch.mjs` | 0/0 | 70/65 |
| `scripts/pre-push-test-selection.mjs` | 311/286 | 376/347 |
| `scripts/pre-push-test-selection.test.mjs` | 260/241 | 341/318 |
| `server/src/__tests__/agents-pending-approval-config.test.ts` | 159/146 | 646/609 |
| `server/src/__tests__/approval-routes-idempotency.test.ts` | 449/407 | 568/520 |
| `server/src/__tests__/approvals-service.test.ts` | 169/140 | 649/582 |
| `server/src/__tests__/error-handler.test.ts` | 124/107 | 149/129 |
| `server/src/__tests__/heartbeat-managed-clone-credentials.test.ts` | 197/184 | 210/196 |
| `server/src/__tests__/heartbeat-workspace-busy.test.ts` | 867/781 | 861/774 |
| `server/src/__tests__/hire-approval-payload.test.ts` | 0/0 | 246/230 |
| `server/src/__tests__/http-log-policy.test.ts` | 73/68 | 103/95 |
| `server/src/__tests__/http-log-redaction.test.ts` | 86/79 | 391/372 |
| `server/src/__tests__/redact-sensitive.test.ts` | 100/80 | 187/159 |
| `server/src/middleware/error-handler.ts` | 148/136 | 175/160 |
| `server/src/middleware/http-log-policy.ts` | 50/44 | 74/64 |
| `server/src/middleware/http-log-redaction.ts` | 13/13 | 21/21 |
| `server/src/middleware/http-logger.ts` | 0/0 | 70/65 |
| `server/src/middleware/logger.ts` | 97/89 | 48/40 |
| `server/src/middleware/redact-sensitive.ts` | 100/94 | 136/129 |
| `server/src/routes/agents.ts` | 4,114/3,782 | 4,116/3,784 |
| `server/src/routes/approvals.ts` | 535/493 | 541/499 |
| `server/src/services/approvals.ts` | 314/288 | 473/439 |
| `server/src/services/built-in-agents.ts` | 2,026/1,909 | 2,027/1,910 |
| `server/src/services/heartbeat.ts` | 19,252/18,061 | 19,255/18,064 |
| `server/src/services/hire-approval-payload.ts` | 0/0 | 260/241 |
| `server/src/services/plugin-managed-agents.ts` | 562/521 | 563/522 |
| `ui/src/components/OnboardingConfigurationReview.test.tsx` | 0/0 | 109/95 |
| `ui/src/components/OnboardingConfigurationReview.tsx` | 0/0 | 157/147 |
| `ui/src/components/OnboardingWizard.config-persistence.test.tsx` | 0/0 | 409/368 |
| `ui/src/components/OnboardingWizard.tsx` | 1,789/1,709 | 1,883/1,798 |
| `ui/src/hooks/useOnboardingAgentConfigReview.ts` | 0/0 | 62/58 |
| `ui/src/hooks/usePersistOnboardingAgentConfig.ts` | 0/0 | 75/69 |
| `ui/src/lib/onboarding-agent-config.test.ts` | 0/0 | 278/259 |
| `ui/src/lib/onboarding-agent-config.ts` | 0/0 | 123/110 |
| `tests/e2e/conference-room-typing-intro.spec.ts` | 105/90 | 89/73 |
| `tests/e2e/planning-mode-visual-verification.spec.ts` | 161/139 | 149/126 |
| `tests/e2e/onboarding-hire-route.ts` | 0/0 | 44/38 |
| `tests/e2e/onboarding-hire-route.spec.ts` | 0/0 | 49/44 |

## Threshold and cohesion review

| Surface | Function evidence | Decision |
| --- | --- | --- |
| Onboarding wizard | `OnboardingWizard` 1,562 to 1,645 source lines, proxy 155 to 165, depth 4; `handleGiveHeartbeat` 99 to 114, proxy 18 to 17, depth 3; new environment verifier 14, proxy 3, depth 1. | Exact-patch exception accepted. The file was already oversized, but Review, comparison policy, query review, and persistence were extracted into four leaves totaling 411 physical lines. The remaining growth is tightly coupled reset/step orchestration. Paperclip #107 owns extraction of the step-4/5 controller before more substantive growth and is due for review by 2026-10-01. |
| Returning-persistence hook | Public hook 46 source lines; nested callback 40, proxy 4, depth 1. | Cohesive prepare, effective-config verification, PATCH, and cache invalidation boundary. It avoids duplicating merge policy in the Wizard. Server-owned revision/CAS hardening is tracked in #105. |
| Agent routes | `agentRoutes` 3,619 to 3,620 source lines; hire callback 173 to 174, proxy 28 to 25, depth 4 to 3. | Exact-patch exception accepted: only one shared payload-preparation import/call grows here, while security decisions move into `hire-approval-payload.ts`. #106 blocks further unreviewed growth and is due for review before the next change or 2026-09-15. |
| Built-in agents | Factory 1,106 to 1,107 source lines; `provision` 111 to 112, proxy 17, depth 4. | Exact-patch exception accepted: one shared preparation call replaces duplicated inline payload handling. #106 owns the next reduction review. |
| Plugin-managed agents | `createManagedAgent` 80 to 81 source lines, proxy 4, depth 2. | Mandatory independent >80 review accepted the one-line central boundary call; splitting that line would add indirection without reducing decisions. #106 blocks further growth without extraction. |
| Approval service | Factory 279 to 425 source lines; `createAgentFromApprovedHire` 49, proxy 20, depth 3. | The outer factory remains a service container. Secret custody, field mapping, transaction phases, reconciliation, and post-commit notification helpers are separated enough to preserve one atomic Drizzle transaction. #106 owns a later workflow extraction. |
| Shell-free command resolver | New `resolveCommandPath` 43 source lines, proxy 18, depth 3. | Cohesive platform lookup primitive using Node built-ins only. `server-utils.ts` shrinks 44 physical lines and `ssh.ts` shrinks 13. This corrects the earlier #63 receipt's decision-proxy undercount. |
| PR #45 disposition generator | 553 physical/527 source lines; `getPreservationRefSupport` 34 source lines/proxy 5/depth 2; `exactResultEvidence` 55/proxy 22/depth 4, `buildCommitRecord` 64, `buildManifest` 69, `validateManifest` 68/proxy 24/depth 4. | Exact-patch >500 target exception accepted. The added logic is one cohesive Git-custody preflight coupled to the pinned constants and injected Git runner; splitting it now would create a second policy surface for the ref/recovery boundary. Patch parsing and disposition policy are already extracted. Revisit before any further production growth; #80 owns the remaining custody workflow. |
| Deterministic pre-push selector | 376 physical/347 source lines; `selectPrePushTests` grows 83 to 96 source lines. Declared mappings are data-only and the deletion/helper ownership conditions remain at depth 2. | Independent >80 review accepts this exact function exception: it owns one ordered fail-closed selection decision and splitting the removed/live/helper branches would duplicate path custody. The file remains below 500 lines. Any further logic growth requires extraction. |
| Onboarding browser journeys | Conference test 89/73 with its main body 59 source lines; planning test 149/126 with its main body 122. Shared route helper/spec are 44/38 and 49/44. | The duplicated adapter-replacing intercept was removed. One extracted helper now preserves the submitted payload and changes only automatic-wake fields, while a registered Playwright spec owns that contract. Independent >80 review accepts the remaining planning-journey body because it is one ordered visual workflow; split its screenshot phases before further growth. |
| HTTP request logger | 70/65; `createHttpLogger` 37 source lines, path/body helpers at most 13, maximum depth 2. | Cohesive logging boundary. Query/params omission, response-time failure context, sensitive-route body omission, claim-path redaction, URL-header redaction, and structural ordinary-body redaction are separated across three small policy modules. |
| HTTP security tests | HTTP output test 391/372; three production-shaped `it` bodies are 100, 86, and 85 source lines. | Independent >80 test review accepts these exact exceptions: each owns a complete ephemeral-server request/log/canary lifecycle for query, structured-body, or sensitive-route evidence. Shared server/request extraction now would blur the distinct negative controls; no further body growth without extraction. |
| Error handler | `errorHandler` 64 to 65 source lines, proxy 27 to 28, depth 5. | Independent complexity review accepted the one call to the extracted structured-log sanitizer; DB-param and recursive redaction logic are outside the handler. |
| Pending-approval DB tests | File 609 source lines; largest real `it` bodies 99 and 89. | Below the 700-line test target. Describe callbacks are declarative test registration. Repeated setup stays local because each transaction/race fixture deliberately changes connection or failure boundaries; extracting one generic builder would obscure the negative control. |
| Existing oversized runtime/test surfaces | `prepareRemoteManagedRuntime` stays 133 lines; `startSshEnvLabFixture` 123; `syncDirectoryToSsh` 115; `syncDirectoryFromSsh` 108. `heartbeat.ts` grows only 3 source lines and `codex-local-execute.test.ts` only 2. | Exact-patch exceptions accepted: the SSH functions do not grow and the file shrinks overall; heartbeat only broadens the drive-prefix rejection with two table cases; the Codex test adds the matching shell-safety assertions. No broad refactor belongs in this reviewed delivery. |

## Generated evidence classification

`packages/adapter-utils/package.json` is declarative gate wiring and grows from
53 to 54 physical lines to run the SSH ratchet before `tsc`.

The operational/declarative records remain below the roughly 800-line action
band: `.gate-evidence.json` 365 to 572, `CHANGELOG.md` 350 to 471,
`CONTRIBUTING.md` 294 to 309, `OPEN_TASKS.md` 428 to 602, the #63 receipt JSON
268, the PR #45 summary 43, this receipt 175, and the PR #108 review receipt
234. They remain navigable by headings or keyed JSON entries; no
current-guidance/history split is required.

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
- #63 final focused adapter-utils set: 41/41 pass. Negative controls named the
  private shell-quoter copy, missing `ps`, invalid managed-runner environment
  key, and missing SSH end-of-options marker for their intended reasons.
- #80 disposition generator: 5/5 pass, including the checked-in custody
  manifest on a generic checkout and protected local-WIP-branch recovery.
  Stale output, absent refs, and a forced local-branch fetch each failed for the
  intended reason; the four preservation commits remain untouched.
- Deterministic pre-push selector: the real push first failed closed on five
  production paths whose existing contract tests were not same-stem siblings.
  The committed missing-declaration fixture names the absent mapped test; after
  restoration, 19/19 selector proofs and the five-path caller-shaped dry run
  passed with zero uncovered files or selection errors. A helper-only change
  also selects its exact registered Playwright contract, which passes 2/2.
- #87 final focused set: 21/21 pass. Deliberately testing the Wizard draft
  instead of the effective preserved config failed 2/7 for the exact hidden
  command/cwd/env mismatch before byte restoration. The final task-owned UI
  typecheck receipt is `c6dfeccede894d5a873e12f1f4df34e7`: exit 0 in
  93,545 ms, peak process/job committed memory 2,433,638,400/2,650,513,408
  bytes, maximum S: free-space drop 190,259,200 bytes, and zero survivors.
  The two real browser journeys pass 2/2 under receipt
  `6600231310d349a48a00b54e2a2a3268` and require authoritative
  Verified / Claude Code / Adapter default readback.
- #88 final HTTP policy/redactor/pino set: 34/34 pass under receipt
  `7162e45e10ef4e2c87aeaae9b579859a`. Negative receipt
  `471e809e531d467ca51902aa71872dfb` failed exactly 8/34 for query leakage,
  missing response-time context, mixed-case route/path bypass, credential-code
  aliases, nonempty plain bindings, and camelCase URL/URI leakage. The final
  independent server set passes 109/109. Server typecheck receipt
  `209d47d2c3564372ad47affe160ee169` exited 0 in 25,521 ms with peak
  process/job committed memory 2,976,444,416/3,199,627,264 bytes and zero
  survivors.
- Adapter-utils typecheck receipt `aa4f80c658944d089a5f749236db98ad`
  exited 0 in 5,315 ms with peak process/job committed memory
  410,644,480/648,970,240 bytes.
- A combined three-package typecheck under receipt
  `a9dbd280a1204987adfd0668cfe2b7a6` exited 134 when the server process reached
  its deliberate 2 GiB ceiling after adapter-utils had passed. The owner proved
  zero survivors. Separate calibrated server and UI runs then passed within
  their declared envelopes; this is resource calibration, not a hidden green
  result.
- `check-token-gates` is clean after replacing one rejected arbitrary grid
  value with standard flex/width utilities; the focused configuration-review
  UI test passes 3/3.
- Real pre-commit/pre-push hooks, hosted exact-head CI, and exact-head automated
  review remain separate delivery gates at the time of this receipt.

Independent reviewer:
`Codex independent stable-diff review — pr108_final_diff_review, 2026-09-01`.
After the reviewer-requested hash/count and extracted-helper evidence repairs,
the exact stable diff has no P0/P1 runtime, security, Windows, approval, UI,
SSH, E2E-helper, or test-selection defect. The exceptions above apply only to
this exact patch. Follow-up custody is explicit in #80, #105, #106, and #107.
