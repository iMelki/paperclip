# Component-Sourcing Preflight — Action Review Dialog (paperclip#48)

Record for replacing all native `window.confirm()` consequential-action sites
with an accessible action-review dialog (EUX-09 / a11y anchor-3 fix from the
2026-08-09 fleet UI/UX Awwwards audit, `docs/uiux-awwwards-report-2026-08-09.md`).

## Component-Sourcing Preflight

- Target app/surface and component job: Paperclip UI (all consequential-action confirm sites: AgentDetail, ApprovalDetail, AgentActionButtons, DevRestartBanner, CompanySettings, CompanyEnvironments, InstanceSettings, SkillStudio, ImportFromVaultDialog, ProjectProperties) - confirmation/action-review dialog
- Target-app component checked: ui/src/components/ui/alert-dialog.tsx (owned-but-idle Radix AlertDialog primitive, already consumed by AgentActionButtons pauseConfirm, BuiltInBundlePanel, DecisionTrainingDrawer, FolderControls, IssueChatThread, Connections); also reviewed the ad-hoc ConfirmDialog in pages/tools/RuntimeTab.tsx and RestoreConfirmDialog in components/RoutineHistoryTab.tsx as house precedents
- Component Marketplace primitive checked: Component Marketplace action-review-dialog.tsx + action-review-contract.ts (fleet EUX-09 primitive, Docs/action-review-dialog.md); borrowed only its typed four-question consequence contract concept and typed-gate fail-closed rule, not the component code
- External pools checked or skipped: skipped because the target app already owns a shadcn/Radix AlertDialog primitive and the repo's tier-1 target-app rule beats importing anything external; no new dependency wanted
- Chosen source lane and why: Tier-1 target-app primitive - new ActionReviewDialog composite plus useConfirmDialog hook composed over the repo's existing ui/alert-dialog.tsx, exactly as issue #48 prescribes ("replace with the repo's own owned-but-idle ui/alert-dialog.tsx via a useConfirmDialog composite"); the four-question consequence contract (happens now / runs after confirm / result appears in / will not happen) is adapted from the fleet rubric section 1.7
- License/access/dependency result: local repo code only; radix-ui already a dependency; zero new packages
- Proof expected before closeout: ui typecheck green, focused vitest suites for the composite + hook + all touched components/pages green, forbidden-tokens gate green, vite build green, Storybook story for standard/destructive/typed-gate states, design-guide showcase section; browser proof bundle against http://127.0.0.1:5113 stays pending while the local runtime is down

## Result

Validated with `Test-FrontendComponentSourcingPreflight.ps1 -RequireKnownPoolMention`;
see the JSON verdict committed alongside this record.
