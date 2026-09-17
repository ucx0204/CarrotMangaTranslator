# MCP multi-page PNG / ZIP checkpoint — 2026-09-18

## Current status

The saved-page multi-PNG and ZIP path is implemented, registered and verified.
The previously pending file arguments, output schemas and ZIP HTTP route are complete.
Verified code revision: `e5b3849b23f9835749253448ea794e0971113d60` on `feat/mcp-app-bridge`.
This document supersedes the earlier incomplete `c126f79c` checkpoint below.
No new branch, master merge, release or live application restart was performed.

All source edits and commits in this completion were submitted through the GitHub
plugin. Remote Desktop Commander was used to inspect, fast-forward synchronize,
compile and test the committed tree. The existing MCP checkpoint workflow applied
only seven additive coverage records; run `35282208661` succeeded (`ced4c6ad`).
The user's earlier link-default changes preserved by `fe0553e2` remain intact.

## Registered tools and workflow

- `carrot_preflight_pages_export`: inspect all or selected pages of one chapter,
  returning ordered page IDs, current revisions, a snapshot and existing app warnings.
  Read scope only; no rendering, model work or page mutation.
- `carrot_export_pages_png`: accept that fixed selection and render sequentially
  through existing app page ownership and the actual renderer. First failure stops
  later pages; completed, failed, cancelled and unprocessed pages remain distinct.
- `carrot_create_export_zip`: pack the existing PNGs from an owned, settled batch.
  Does not render again. Partial output requires explicit `allowPartial: true`.

The session registers all three; all 56 tool names have output contracts, including
server identity. The isolated native fixture omits server identity and exercises 55.
Use existing `carrot_get_job` to await completion. Job status and job history remain
metadata-only before and after requesting a file; they never attach files or leak URLs.

`carrot_get_job_file` accepts an explicit `pageId` for one completed batch PNG.
Omit `pageId` for a single-page PNG or a ZIP job. Default output is a text link and
validated metadata. Only `includeAttachment: true` adds the corresponding PNG/ZIP
resource link. This call never starts rendering or ZIP creation.

## File transfer and regression repairs

PNG and ZIP outputs use discriminated schemas and matching MIME types, sizes and
filenames. The existing opaque artifact route supports GET and HEAD, binds the suffix
to the stored media type and streams ZIPs with backpressure rather than buffering them.
Host/Origin checks, scope checks, ownership, page/snapshot revisions, image redaction,
expiry, no-store and nosniff remain enforced. No arbitrary filesystem path is accepted.

Concurrent expiration cleanup now shares one promise, including its failure; it cannot
subtract the same file budget twice or admit a second writer past failed cleanup.
A ZIP retains every source image's authorization/redaction guard after packaging,
without depending on the earlier PNG link's expiry or source temporary-file retention.
Stream failures after headers are sent terminate the incomplete transfer instead of
rewriting headers or appending a JSON error to the ZIP. Client disconnects release streams.

## Verified results

Final Windows `node scripts/check.cjs` (the `npm run check` entry point) exited 0.
All 26 stages passed: types, formatting, lint, error handling, test boundaries,
architecture/maintainability, generated files, dead code, coverage, Windows build,
image protocol and renderer/preload bundle checks.

- Full tests: 7,533 passed, zero failed, 11 existing skips (7,544 total).
- MCP focused tests: 723 passed across 98 files.
- Exact coverage gate: 753 existing records, 798 introduced records, 10 recorded
  deletions; the prior 1,544 floor entries were verified unchanged.
- Job journal and artifact HTTP: all four measured metrics at 100% after adding
  restoration, filesystem failure and streaming-disconnect regressions.
- Existing page artwork parity: both cases had zero differing pixels.
- Native Electron: actual registered two-page PNG export matched individual export
  pixel-for-pixel; ZIP entries matched the PNG bytes and preserved page order.
- Native GET/HEAD, size/hash, unchanged original/saved fixture data, and actual
  post-export redaction refusal all passed. The isolated test port was closed afterwards.

Native export acceptance uses actual app storage, ownership, renderer and ZIP writing.
Other existing native OCR/erasure tests use deterministic inference boundaries; they
are not claims about real-model quality. No user library or credentials were used.
The new ZIP flow was not exercised through the live ChatGPT/Tailscale connection;
that connection and the user's running app were not restarted or reauthorized.

Logs remain in the existing review worktree:

```text
.tmp/mcp-export-github-complete-check.log
.tmp/check-timings.json
.tmp/check-results/vitest.json
.tmp/mcp-export-focused-final.log
.tmp/mcp-export-focused-coverage-final/
.tmp/mcp-export-github-native.log
.tmp/mcp-export-github-compile.log
```

See `docs/mcp-export-coverage-20260918.md` for initial measurement provenance and the
explicit distinction between Vitest metrics and native-only adapter verification.

## Limits and next work

One batch covers 1–50 pages of one chapter. PNG limit: 64 MiB each; ZIP: 128 MiB;
session output budget: 256 MiB. Exceeding a budget fails explicitly, never downsamples.
The links expire ten minutes after file creation and also stop working on revocation,
relevant page/redaction changes or server shutdown. The existing generic HTTP response
deadline still applies; maximum-size downloads over slow public links were not benchmarked.

Job receipts persist for seven days, but session PNG/ZIP files and in-flight plans do
not restore after restart. There is no automatic resume, implicit rerender, automatic
partial ZIP, multiple-volume archive, PSD output, OCR, translation or erasure in this
new export workflow. Persistent output storage and large-transfer policy are follow-ups.

The user has already completed the earlier editing live tests; do not require them
again. The former missing registration/file/schema/ZIP-route tasks are closed.
Next feature work can proceed to the agreed independent lettering/font operations,
while persistent output storage and slow/large transfer support remain separate tasks.

## Historical checkpoint

`c126f79c` preserved the batch services before public registration and HTTP integration.
The later retention regressions and initially missing coverage registrations are now
resolved above. Do not reuse that historical checkpoint's pending list as current status.
