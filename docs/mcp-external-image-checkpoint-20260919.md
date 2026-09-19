# Bundle 5 external image/mask checkpoint - 2026-09-19

Status: IMPLEMENTED AND REGISTERED; ALL AUTOMATIC GATES PASSED; LIVE DEFERRED.
Baseline: `a59eab89`. Verified production/test code: `0af0ba95`.
Continue only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. Bundles 1-5 are implemented with automatic
checks complete. User artwork, actual model quality and live client acceptance
remain deferred until all bundles are implemented. This closes the interrupted
bundle-five work, including the formerly preview-only background application.

## Receiving actual files

Five upload tools are connected:

- `carrot_begin_image_upload`
- `carrot_write_image_upload`
- `carrot_finish_image_upload`
- `carrot_get_image_upload`
- `carrot_discard_image_upload`

They accept complete nonanimated 8-bit PNG files as bounded canonical base64 chunks,
not filenames, remote URLs, arbitrary PC paths or opaque client file handles.
The existing 64 KiB HTTP body limit is unchanged. Each decoded chunk is at most
32 KiB; an upload is at most 32 MiB and 16 million pixels. The session reserves
at most 128 MiB across 32 files, with 256 begin receipts and 4,096 chunk offsets
per file. Exact existing chunk retries remain valid at the chunk limit.

A receiving receipt is not a validated asset. Finish verifies received length,
SHA-256, PNG framing/CRC and declared dimensions. Binary masks require opaque black
and white pixels: white selects and black preserves. There is no threshold,
implicit alpha mask or rescaling. Uploads have a fixed 30-minute expiry; inspection
does not extend it. Explicit discard and session close clean staging. Incorporated
artwork and native history do not depend on staging staying present.

## Review and separate application

Seven tools provide review, image inspection, application and recovery:

- `carrot_preview_external_image`
- `carrot_get_external_image`
- `carrot_get_external_image_preview`
- `carrot_apply_external_image`
- `carrot_undo_external_image`
- `carrot_redo_external_image`
- `carrot_cancel_external_image`

Commands distinguish full background replacement, exact-size original-pixel patches
and lettering on one existing block. Images and optional selected/protected masks
must belong to the same connection and saved page/context snapshot. Protection wins;
unselected background pixels retain the current cleaned image. Selected background
pixels must be opaque. Original files, text, layout and block order are preserved.
Preview does not save a page or produce native background artifacts.

Background application uses the existing image publication transaction and
InpaintingRevisionStore. Its internal request type was narrowed to the evidence,
recovery and outcome fields actually consumed; no runtime authorization, revision,
source hash, pixel-boundary or history guard was removed. Staging uses canonical
native artifact naming and retouch difference-mask calculation. The mask retains
the native difference tolerance and retouch-updated provenance, not an assertion
that all original text is gone. Existing workflow completion becomes pending on
background modification and its previous value is retained for native recovery.

Lettering uses native generatedLettering and exact block snapshot commits. Existing
layers require explicit replacement; decorations can be preserved or cleared.
Source/translation strings, coordinates, other formatting and other blocks remain
unchanged. An asset preview is not the final transformed renderer. Normalized
lettering is bounded to 2 MiB per PNG; the shared 4 MiB retained-plan budget also
applies. This does not prove that the image's actual words match the saved text.

Apply checks source/cleaned/mask evidence, page/context membership and uploaded bytes
under native page ownership, including upload expiry at persistence. Image previews
require image scope and honor redaction; metadata inspection transfers no image.
No model, OCR, translation, erasure, remote fetch, asset download or authentication/
settings mutation is implicit. Only PNG is supported by this upload boundary.

## Recovery and limits

No-change plans are excluded. Output is acknowledged before UI notification; a
later notification failure is an explicit partial result, not an unrecorded save.
Cancellation stops pending publication and is not rollback. A cancelled plan needs
a new review before a new apply; old action receipts never repeat a mutation.
Undo/redo use retained native images/masks or block snapshots, not another upload
or model call. Later user edits and changed native artifacts conflict. Undo permits
changed context; redo still rechecks context. Background references are capped at
64 per owning session and released at close without deleting current saved assets.
Cleanup failures are surfaced while both native history and staging cleanup are
attempted. Recovery is session-only with the shared 30-minute idle plan lifetime;
durable recovery remains bundle 7, and chapter orchestration remains bundle 8.

## Verified automatic results

The full repository check at `0af0ba95` completed successfully:

| Check | Result |
| --- | --- |
| Repository stage graph | All 26 stages passed, every exit code 0 |
| Complete Vitest/V8 suite | 7,833 passed; zero failed; 11 pre-existing skips |
| MCP cases in complete suite | 1,019 passed across 145 files; zero failed |
| Background/layer/HTTP/image/output focused suite | 39 passed across seven files |
| Additional PNG/decoder/cleanup focused suite | 10 passed across two files |
| Renderer, Electron and JavaScript types | Passed |
| Lint, formatting, architecture, duplicates, unused exports, mock boundaries | Passed |
| Exact production coverage-floor gate | Passed |
| Windows build | Passed |
| Existing page-artwork parity, image protocol, renderer/preload checks | Passed |
| Extra isolated real-Electron external image smoke | Passed; terminal marker and exit code 0 |

Canonical full-check record: `.tmp/check-timings.json`, started at
`2026-09-19T03:48:33.498Z`, completed at `2026-09-19T03:51:57.408Z`.
Preserved summary: `.tmp/mcp-external-final-check-timings.json` and
`.tmp/mcp-external-final-evidence.json`. Complete result:
`.tmp/check-results/vitest.json`; stage logs: `.tmp/check-logs/`;
wrapper: `.tmp/mcp-external-final-check3.log`.
Test digest: `88442326fb70a7a0eab76e596cedb89716a4bdf7966ecece862d6454316102fd`.
Coverage digest: `53e118d2e13df92eddb2a80a825c2769681a1947a1066c2a51cfef1d156661f7`.

The interrupted slice had already registered 13 measured modules. Two background
modules were measured and added in this continuation, preserving all 1,623 existing
rows. All 1,610 rows from the completed bundle-four baseline, provenance and ten
deletions remain unchanged; the manifest now contains 1,625 rows. Initial inventory
and coverage-path failures were resolved by actual registration and additional
behavioral tests, not lower floors. Prior complexity/length and HTTP fixture errors
are also resolved. Exact provenance is in `mcp-external-image-coverage-20260919.md`.

## Real Electron verification and test interpretation

Command: `node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs`,
with `CARROT_MCP_SMOKE_PORT=38551` and `CARROT_MCP_SMOKE_TAILSCALE=0`.
Log: `.tmp/mcp-external-native-20260919.log`. Exit code 0; the log ended with
`PASS MCP native smoke finished`. The new check explicitly reported
`PASS native external PNG chunks -> protected background pixels -> image history -> lettering layer -> exact recovery without models`.

The new native script uses actual Electron decoding, tool-uploaded PNG bytes,
native background publication/history and block-layer saving. It verifies changed
and protected sampled colors, exact revision recovery, unchanged original bytes,
lettering preservation and undo/redo after staging discard. Unit/integration tests
add every-pixel candidate/outside-boundary comparisons, full replacement and partial
patches, scoped OAuth/HTTP, stale originals, later edits, cancellation, empty masks,
partial saves, native decoding disagreement and filesystem cleanup failures.
Only external Electron image I/O is substituted in the unit fixtures; native smoke
uses actual Electron. Heavy inference in older smoke cases remains substituted.
No inference or download is performed by the new external-image checks.

No live app restart, user artwork/library/authentication change, model download,
master merge or release was performed. Current chat attachment reception and public
Tailscale file delivery were not tested. A host must supply actual file bytes;
unsupported file handles or claimed filenames are not treated as received images.
Detailed boundary record: `mcp-external-image-boundaries-20260919.md`.
NEXT: bundle 6, independent sound-effect preparation, text, image generation and
recovery. Do not repeat bundles 1-5 or request intermediate live acceptance.
