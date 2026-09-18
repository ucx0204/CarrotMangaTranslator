# Connected bundle 2 lettering - 2026-09-18

Continue only on `feat/mcp-app-bridge` in the existing review worktree.
This supersedes the missing-resource and incomplete-forward-check sections in
`mcp-lettering-checkpoint-20260918.md`. Historical verification stays in that file.
Live user/model/client acceptance remains deferred until bundles 1-13 are built.

## Implemented connections

The existing six lettering plan/action tools remain registered. Two read-only
queries are now registered even when editing/processing are disabled:

- `carrot_list_lettering_resources`
- `carrot_get_lettering_resource`

The output registry contains 74 strict tool contracts. Queries require read scope;
preparation and mutation keep existing read/edit/process authority and job ownership.
No query applies a style or launches a model. No query writes resource usage dates.

Resource kinds are preset, rule, sequence and block-style. List queries search
literal names/IDs and return at most 25 entries, each with an item snapshot. Later
list pages require the list snapshot. Item inspection uses the item snapshot and
returns safe native format JSON, advanced transforms and at most five enabled
rule drafts per page. Oversized rules are unsupported, not silently truncated into
an executable recipe. User-authored rule definitions may include match text; raw
block-template source/translation text, geometry and image bytes are not exposed.

`carrot_prepare_lettering_batch` accepts command kind=resource with resourceKind,
id, snapshot and optional groupIds. Presets and block-library styles may use only
the explicitly selected native style groups. Rules/sequences reuse the native
conditional evaluator; enabled sequence steps run in saved order. Text-replacement
and reference-edit actions are reported as unsupported in this lettering workflow,
not silently executed or skipped. Disabled steps do not execute. Generated-image
block templates are unsupported as reusable text styles.

The native preset group builders and app appliers remain authoritative. Block-style
reuse never inserts a new block or copies its template text, bounds or image.
Manual font sizes stay protected by default, including during saved-resource reuse.
Advanced block-library transforms are applied only when transform is selected.

## Freshness, storage and recovery

Every forward save checks ALL selected page revisions, chapter membership/context,
and its previously acknowledged plan commits. Geometry checks original/cleaned
image evidence; style operations check the font catalog. Saved-resource operations
also recheck the exact definition and its enabled sequence dependencies before
publication and every forward save. Changed or deleted definitions stop further
saves. A previous acknowledged save stays explicit and can be undone separately.

Undo uses the owned exact prior snapshot, restoring omitted-field absence, and
never requires a deleted preset, missing model or expired source image. It still
refuses to overwrite a later user edit. Redo requires the original resource and
all forward dependencies to match again. Native page/context leases are retained;
external filesystem changes are detected, not prevented by a system-wide lock.
Resource fingerprints identify the reusable definition, not font binary hashes
or a per-string proof that every character is supported.

Preset metadata reads no longer call the general app settings loader, which can
repair mirrors or migrate settings. A narrow public-settings projection uses the
existing serialized settings-pair reader in read-only mode. It verifies committed
file hashes and generation without decrypting credentials, repairing mirrors,
rolling back, migrating or probing hardware. Missing legacy files yield no presets;
malformed/current-corrupt data fails instead of returning a fabricated empty list.
Default app settings loading retains its previous repair and recovery behavior.

## Static boundaries and automatic verification

The two prior job-journal complexity findings were removed by early-result handling
and a separate page-target validator without changing receipt expiry or validation.
The seven prior architecture findings were resolved with exact measured consumers
of existing authorities: fingerprint 38, native schema 29, rich-text parser 32,
MCP typed errors 71, library facade 49, output composition imports 14 and page-session
composition imports 23. Global limits remain 12 runtime imports / 25 consumers.
No forwarding wrapper, duplicate parser/error authority or global exemption was added.

The focused run passed 908 tests across 125 files (MCP plus settings-pair regression
suites). Renderer typecheck, lint and architecture checks passed. Five new modules
were measured: 107/110 lines, 113/116 statements, 36/36 functions and 56/61 branches.
All 1,583 inherited coverage records, provenance and deletion entries were retained;
only five actual measured rows were added. Inventory: 753 baseline, 835 introduced,
10 unchanged deleted files. Full repository acceptance is recorded below after the
current full check completes; these focused results alone are not an all-gates claim.

Only temporary fixture libraries/settings are used. Native source hashes, preset
projection, conditional evaluation, transactions, page handoffs and OAuth/HTTP are
real implementation paths. Koharu inference is substituted. No live user app was
restarted; user artwork, library, credentials and approved model assets are untouched.
No actual ChatGPT/Tailscale call, download acceptance, master merge or release ran.

## Scope and next implementation

Bundle 2 covers independent geometry/wrap/style preparation, saved resource
query/reuse, guarded application and exact session Undo/Redo. It does not expose
arbitrary global-settings writes or library-template insertion. Durable history
is still bundle 7; history here remains bounded and session-only.

After all automatic gates pass, the next implementation is bundle 3: remaining
region/multi-block OCR, selective translation and block references. Do not repeat
bundle 1 or request intermediate live-model/client acceptance.
