# Bundle 3 selection application boundaries

Baseline: `06b1a73c`, same `feat/mcp-app-bridge` worktree. This continuation
connects the previously missing application/reference slice. User/model/client
acceptance remains deferred until all roadmap bundles are implemented.

## Explicit tools and authority

Six new tools: `carrot_preview_selection_batch`, `carrot_get_selection_batch`,
`carrot_apply_selection_batch`, `carrot_undo_selection_batch`,
`carrot_redo_selection_batch`, and `carrot_cancel_selection_batch`.
The actual app composition supplies the native edit callbacks only when local
editing and processing are enabled. Preview and mutations require read/edit/process;
inspection needs read permission and ownership. No model or image scope is implied.

Analysis application requires an owned completed selection operation and its
unexpired observation record. The transport accepts item IDs, not arbitrary
model text or internal blocks. A caller cannot borrow another connection's
observation, change its mode, substitute page versions or mix reference edits
into an analysis command. Existing legacy scalar edit tools keep their own
contracts; they are not implicitly converted into analysis-bound writes.

A preview covers one chapter, 1-20 pages and at most 100 selected changes.
Only one change may target a given existing or newly created block in that plan.
Preview never saves pages or runs inference. New-block defaults are read from the
existing public-settings generation without secret hydration, migration or writes,
then normalized by the same app normalizer. The normalizer now types only the
public default field it already consumed; its algorithm is unchanged.

## Field, discovery and order boundaries

Source and translation edits reuse the native field editor. Empty observations
are excluded rather than clearing saved text. Generated lettering is excluded.
Source-only updates keep saved measurements and emit a review warning; no OCR,
font analysis, mask rebuild or rendering is secretly triggered.

A discovered OCR region may be appended only by its exact result sequence.
Reported overlaps require explicit approval. Containing original-pixel bounds
are checked by native block creation, not clipped. Oversized source text is
rejected, never truncated. Native deterministic block IDs, defaults, geometry
and effective reading order are reused. Omitted insertion anchor means tail;
null means first; otherwise it names an existing block on the same page.
Existing blocks and their relative reading order are preserved. This is not
unreviewed page replacement or automatic insertion of every detected region.

Reference edits accept enabled unique native character/glossary IDs in that work.
Missing fields preserve state, null removes the field, and an empty glossary list
is a stored empty list. Unknown/disabled/duplicate IDs fail. Block reads now expose
only these native reference IDs, not full character records or private artifacts.

## Save, cancellation and recovery

The existing page-batch state machine and native page handoff are reused.
The common calculated-snapshot commit accepts blocks plus optional order, allowing
append/order changes to use the same atomic save and receipt-before-notification
boundary as existing formatting. Array-only consumers retain their old behavior.

Forward commits recheck every analysis dependency, chapter membership, context,
page revision and, for OCR, original-file hashes. Native non-waiting read leases
are acquired only after the target page handoff, avoiding reversed lock order.
The fixed observation deadline is checked again at the synchronous authorization
boundary before persistence. External filesystem races are not claimed impossible.

Pages commit sequentially; the first failure/cancellation stops future saves.
Already committed pages remain explicit partial results, including a failed UI
notification after persistence. Exact request retries return historical receipts.
Undo restores only owned snapshots, exact optional fields and prior order absence
or legacy order; it removes only the owned new blocks. Later page edits conflict.
Undo does not need an expired observation or deleted context entry, but forward
redo does need its fixed evidence and context. Session history has a 30-minute idle
lifetime; restart does not restore it. Permanent recovery remains roadmap bundle 7.

## Narrow architecture declarations

No global 12-import/25-consumer limit changes or dependency-hiding aliases:

- pageRevision: 54 to 55 consumers, one selected observation projection.
- blockFingerprint: 38 to 41, selection projection, plan and protected snapshots.
- mcpEditPolicy: 76 to 80, four selection policy/adapter typed-error consumers.
- library: 52 to 53, the native selection edit composition root.
- mcpOutputSchemas: 15 to 16 imports, direct selection output-family registration.

These reuse the existing hash, error, revision, library and schema authorities.
They do not introduce another model queue, parser, renderer or save mechanism.
Detailed automated results and exact coverage provenance belong to the connected
checkpoint once final checks finish; no live acceptance is inferred from mocks.
