# Readable decision confirmations

The expanded Decisions queue repeats a confirmation's title and prompt across
the row and the interaction card. Markdown in prompts and summaries appears as
literal punctuation. This makes the decision harder for a person to read.

The queue omits the inner title only on an exact, nonempty match. Different
titles and fallback headings remain visible. A generated confirmation excerpt
disappears only when the exact full regular pending interaction is available
and its prompt is rendered. Loading, malformed, tool-action and resolved cases
retain context, as do plan-document titles and other distinct detail types.
Pending confirmations omit a summary only when it exactly matches their prompt.
Distinct context and the complete approval scope stay visible. Existing targets,
labels, reason requirements, resolver policies and mutation handlers are retained.
Text formatting uses the existing Markdown renderer with automatic images and
diagrams disabled. Links, code blocks, tables and checklists in these text fields
remain passive, with no child controls or focus stops in the expand control.
Image and link references remain visible as text. Raw HTML and unsafe
URLs remain under the renderer's existing restrictions. Rich document bodies
keep their existing behavior.

The shipped Paperclip skill now tells agents to ask a concrete question, state
time or cost, explain each choice and avoid repeating the same passage. This
guidance requires adoption proof before it can be claimed active in a runtime.
Existing revision-bound decisions are not paraphrased or resolved by the UI.

Acceptance requires one copy of repeated text, preserved distinct context, visible
approval limits and exact target; unchanged accept/defer semantics; readable
formatting; no new automatic media loading; and regression coverage for resolved,
stale, agent-addressed and failed interactions. Browser checks should cover narrow
and desktop layouts and keyboard focus. Publication, independent source review
and runtime installation require their own evidence.

Research chose the app's MIT-licensed components and existing renderer. No new
dependencies or copied marketplace source are needed. The local marketplace's
rights were unresolved, so its controls were only comparison material.
