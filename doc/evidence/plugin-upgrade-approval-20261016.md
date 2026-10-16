# Private candidate: dormant plugin upgrade and capability approval

Status: four original failures observed, supported-path repair applied, non-author
source review accepted, all 44 focused regressions passed, and original host
production typecheck passed. Private successor commit and installation remain pending.

Owning context: Paperclip #129 (host adoption), #126 (bounded import), private
Agent Settings #1620. This document does not authorize a public write.

## Confirmed defects

The existing disabled GitHub plugin cannot use the deferred upgrade route:
`plugin-lifecycle.ts` rejects `disabled` before handling `activate:false`.
Separately, `plugin-loader.ts` throws on every added capability before lifecycle
can retain the documented `upgrade_pending` state. Neither was triggered against
the live instance during this investigation.

Upstream independently reports the latter:
[paperclipai/paperclip issue #13018](https://github.com/paperclipai/paperclip/issues/13018).
The normative contract is local `doc/plugins/PLUGIN_SPEC.md` sections 15.3 and
25.3. The [official administration guide](https://github.com/paperclipai/paperclip-docs/blob/main/docs/administration/plugins.md)
describes staging offline, reviewing Permissions and then explicitly enabling.
Its workaround proposals are evidence only, not permission to bypass a guard.

## Required repair boundaries

- Use existing registry, loader, lifecycle and instance-admin Enable action.
- Accept disabled upgrades only with explicit deferred activation.
- Save the startup hold before unload or replacement; failures remain held.
- An internal staging discriminator requires the saved pending state. It is not
  approval, and the loader's default capability-escalation refusal remains.
- Repeated upgrades of a pending manifest do not approve or activate it.
- Manifest replacement and status approval bind to the validated status and
  manifest snapshot in the SQL mutation predicate. A lost snapshot is a conflict,
  not a retry with a freshly read target.
- Keep the same plugin identity, configuration and history. Do not Enable the old
  worker, forge its manifest, or uninstall/reinstall to escape the approval path.
- Separate plugin capability approval from the human's GitHub OAuth Authorize.

## Qualification

Use the existing Chief-owned bounded test facility, original server Vitest
configuration and one worker. Synthetic package directories remain retained.
Loader tests mock npm/child execution; no live database or provider is supplied.
Compose the real loader upgrade path with lifecycle to expose the original gap.

Tests must cover disabled deferred success, default disabled refusal, hold-before-
replacement ordering, added-capability staging, default escalation denial,
nonpending staging denial, lost hold, same-ID protection, repeat-pending refusal
to activate, explicit Enable, stale approval conflict and unchanged legacy
ready/same-capability behavior. SQL predicate tests must bind the caller's old
manifest even when the preliminary read has changed.

Actual original failures and repaired passes must be recorded separately against
exact source hashes. Source tests are not installed, served or live-import proof.
No whole plugin typecheck/dependency/restore replay is needed for this host-only
change; their accepted evidence remains separately bound.

Original baseline execution: 5,954 ms, exit 1; all four selected cases failed for
their expected production defects. The other 24 of 28 discovered cases were
unselected, not failed or accepted passes. Nine input post-pins stayed stable;
owned root/tree reached zero and both captures were complete with zero dropped
bytes. Two failures reached the disabled rejection, one the added-capability
throw, and one demonstrated a repeated pending upgrade incorrectly becoming
ready. The repaired candidate is separately pinned for four focused files.

Repaired execution: 8,621 ms, exit 0; all 44 discovered assertions passed with no
skips (20 lifecycle, 13 real-loader path, 9 registry and 2 restart regressions).
Eleven input post-pins stayed stable; owned root/tree reached zero and complete
healthy captures dropped no bytes. The source review found no introduced
actionable defects. Registry concurrency coverage is a compiled SQL predicate
and conflict-path test, not an observed real database race. See the repository's
negative-proof ledger for the exact private request hashes.

Production typecheck: original server config with noEmit and incremental disabled
passed in 55,103 ms, exit 0, no diagnostics. Its pre-existing test exclusion was
unchanged. Nine post-pins stayed stable; owned root/tree zero and complete healthy
captures with zero drops. Process peak 2,937,806,848 bytes stayed below its
unchanged 3 GiB cap. This proves production types, not live runtime compatibility.

## Installation and acceptance still open

Known pre-existing limit: activation refreshes the on-disk manifest through
`refreshPluginManifestFromPackage`. The new database CAS is not immutable-artifact
proof and does not harden that separate refresh path. Keep exact built hashes and
sole-writer custody, recheck them before any separately approved Enable, and
refuse disk drift. General refresh-path hardening is separately tracked privately;
no live drift or exploitation is claimed.

The original owner retains the same-task cutover, protected rollback and exact
Windows ownership/ACL checks. Rebind the successor commit before adoption.
Keep the old plugin disabled and pause its exact retained scheduled job before
new activation. No broad sync or unrelated agent stop is authorized.

After installed and served identity is verified, resume the existing Asimtop
OAuth draft. The human alone clicks Authorize. Then bind personal Project #12
to the existing MemSys project and run the two bounded imports: stable task and
membership IDs, second pass creates zero/reuses one, and no attributable agent
or provider runs. None of those live outcomes is claimed here.
