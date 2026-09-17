# Chapter text search and translation batch closeout

## Verified implementation

The inspected and tested source commit is `c08ca41edcf38ac5bf086c3d71599ea024dbcb4c`
on `feat/mcp-app-bridge`. This closeout changes documentation only; it does not
claim another implementation rewrite. The updated live connection exposes and
successfully calls all seven chapter text search/batch tools.

AI clients select corrections by reading source/dialogue/context. End users do
not need to provide block IDs, coordinates or edit arrays. Search candidates are
not automatic replacements, and successful persistence is not visual approval.

## Fresh Windows repository and native checks

- `npm run check`: all 26 stages passed; process exit code 0.
- Vitest/V8: 7,469 passed, zero failed, 11 existing skipped (7,480 total).
- Existing coverage floors, architecture gates, type checks, lint, build,
  artwork parity and image protocol checks passed without a new relaxation.
- The isolated Electron smoke was run through `node node_modules/electron/cli.js`
  on a separate port. It printed the native chapter text search -> multi-page
  batch -> undo/redo -> exact rendered restoration marker and the final
  `PASS MCP native smoke finished` marker, with process exit code 0.
- The live app listener on port 38475 was not stopped. The isolated smoke used
  port 39595. An occupied-port precheck and a direct GUI-executable launch with
  an empty log were NOT counted as successful native verification.

Local evidence:

```text
.tmp/mcp-text-batch-closeout-20260918-011141/check.log
.tmp/mcp-text-batch-closeout-20260918-011141/check.exit
.tmp/mcp-text-batch-closeout-20260918-011141/native-cli.log
.tmp/mcp-text-batch-closeout-20260918-011141/native-cli.exit
.tmp/mcp-text-batch-live-20260918-011307/check-timings.json
.tmp/mcp-text-batch-live-20260918-011307/verification-summary.json
```

The directory date is the Windows local date; corresponding raw timestamps use
UTC on September 17. Repository checks above are this fresh local execution,
not an assertion that a later documentation commit's GitHub CI has finished.

## Live MCP acceptance

Only the existing `MCP Edge Audit 20260916 / Disposable synthetic pages` fixture
was modified. Its 14 work files were backed up and byte hashes verified first.
A source-text `HELLO` search selected three greeting blocks on three pages;
neighboring `TEST PAGE 123` blocks were intentionally excluded after reading full
blocks. The AI wrote individual Korean corrections rather than blanket replacing
all strings. This is a synthetic workflow test, not a general language-quality
or ambiguous-intent benchmark.

The main batch was `7aa49c47-f907-45dd-a751-569a83e1117b`.
Previewing left `chapter.json` byte-identical. Explicit apply completed all three
pages. File comparison showed only those translations and normal modification
timestamps changed. Undo restored all three original page revisions; redo
returned all three to their initial applied revisions. Replaying the older undo
action after redo returned a historical receipt without undoing again. Reusing
an apply request ID for redo was rejected. Cancelling an already completed action
did not change it. A final new undo action restored the fixture translations.

All three changed pages were explicitly rendered. The inpainted page and the
page with separate display frames showed the corrections clearly. The OCR-only
page has source and display frames in the same location: translated text overlaps
the unerased source. This is NOT reported as a visually finished translation.
No erasure, source rewrite or formatting change was silently performed to hide it.

The partial-failure batch was `aadb73f4-186f-4ef9-bbf5-02fd84bece01`.
After previewing, a separate translation edit changed an unrelated block on its
second page. Apply saved the first page, rejected the second with
`revision_conflict`, and left the third unprocessed, returning `partial`.
Undo restored only the committed first page and preserved the subsequent edit on
the second page. That deliberate test edit was then explicitly restored too.

## Search and malformed-request checks

Snapshot-bound browse pagination returned all five blocks without duplicates.
Exact `HELLO WORLD` matched two blocks while contains `HELLO` matched three.
Emoji offsets used UTF-16 (two units for the supplementary character). Literal
`.*` matched nothing and was not executed as a regular expression. Searching
without a query was rejected rather than silently browsing the whole chapter.
An old pagination snapshot was rejected after page text changed. Duplicate block
edits, clearing nonempty text without `allowEmpty`, and an incorrect context
revision were rejected before saving. Batch/action/status responses did not
attach images or download links.

## Final preservation

Explicit before/final PNG exports completed for all three pages. The app-returned
SHA-256 values and byte counts matched exactly:

| Page | Bytes | Before/final SHA-256 |
| --- | ---: | --- |
| external.png | 14908 | 89fb027ab3520f857ef73a2c3f4c83b90ba17d2a726bb43c5e52d904a2a84c3c |
| ocr.png | 13271 | 3ed39428936097c27855d0299243fc0df26c3ddadde5e56f6d4c9fb0cdf0e990 |
| render.png | 12297 | 00334b6123c8b6451ec87fc3cf15ad6629508375eafc17eccfc1d470ba978e35 |

Independent PC file comparison found only `work.json` and `chapter.json` changed,
solely in their ordinary modification timestamps. All blocks, source texts,
translations, geometry, styles, order, images, masks, OCR caches, style guide and
story memory were preserved/restored. Test histories, export records and backups
remain. No ordinary work, credential, model setting or tunnel setting was edited.
No OCR, translation model, image-generation or Tavily call was requested. The
normal app was not restarted for this acceptance.

## Boundaries

The live test covered three pages, not the maximum 50-page/1000-block limits.
Cancellation during an active save, permission revocation, generated-lettering
protection and notification-failure boundaries remain automated-test evidence;
they were not forced into the normal live app during this run. No new bug was
observed in the tested live paths. The same-session history and expiry limits in
the checkpoint still apply; this is not durable recovery or local-model batching.
