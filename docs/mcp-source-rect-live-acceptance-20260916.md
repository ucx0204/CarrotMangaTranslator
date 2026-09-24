# Source rectangle: live connector acceptance

Tested application code: `6a41165d0cd0de87994f0647ff30cb4260ed0c5c`.
Branch: `feat/mcp-app-bridge`. Device log time: 2026-09-16 UTC.
This supplements the earlier isolated acceptance in `mcp-source-rect-checkpoint.md`.

## Actual live calls

The `망번테스트` connector exposed and successfully invoked
`carrot_update_block_source_rect`; no app restart or authorization reset was needed.
Two existing disposable synthetic pages were selected, never a normal manga work.
The fixture chapter and all 10 associated files were backed up and hash-verified.

- `render.png`: two blocks with Korean translations and explicit display frames.
  First source rectangle: `(35,55,280,55)` -> `(35.25,55.5,296.5,55.25)`.
- `external.png`: multilingual translated text plus existing inpainting and mask.
  Source rectangle: `(35,55,280,42)` -> `(36.5,54.75,283.25,43.5)`.
- Both edits saved the requested fractional bounds. Text, display frames, stored
  typography, reading order, non-target blocks and image/mask assets were retained.
- The second page returned `erasure_and_masks_retained`; it did not regenerate them.
- Each original rectangle was restored by an explicit new edit with its current
  revision. Both page revisions returned to their pre-test values.

## Render comparison

Each page was exported before editing, after editing and after restoration.
All six jobs were polled to `completed`. Within each page, all three completed
responses had identical PNG dimensions, byte count and full SHA-256:
| Page | Size | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| render.png | 480x640 | 12297 | 00334b6123c8b6451ec87fc3cf15ad6629508375eafc17eccfc1d470ba978e35 |
| external.png | 480x640 | 14908 | 89fb027ab3520f857ef73a2c3f4c83b90ba17d2a726bb43c5e52d904a2a84c3c |

Digests above are from completed app export responses, not a separate ChatGPT
attachment download. Remote storage checks independently hashed all 10 fixture
assets and compared full chapter JSON before, during and after the edits.

## Live edge cases and cleanup

Current revision + identical bounds returned `already_applied`, `changed:false`.
Stale revision + identical bounds returned `revision_conflict`.
Off-page bounds and bounds below the normalized minimum returned `invalid_edit`.
A nonexistent block returned `not_found`.
The no-op and four rejected requests left chapter.json byte-for-byte unchanged.
After final restoration, the only chapter JSON differences were chapter.updatedAt
and the two edited pages' updatedAt. All block contents, other pages and asset
hashes matched the backup. Six export receipts and temporary outputs were retained.

## Additional checks and limits

Focused policy/service/layout/HTTP tests: 36 passed across four files, exit 0.
The full repository check was not rerun; no application code was changed.
Live tests used explicit render frames. Legacy frame pinning, coupled automatic
typography rejection, permission revocation and ownership races were not induced
in the user's running app; related coverage remains in the focused test suites.
No OCR/inpainting model request, credential change, app shutdown or force-unlock
was performed. Source edits and job polling returned metadata, not attachments.

Evidence (ignored local files, not published with the repository):
`.tmp/mcp-source-rect-live-20260916T145124Z/` contains `before/`,
`asset-manifest-before.json`, `render-after-edit.json`, `masked-after-edit.json`,
`after-restoration.json`, `storage-verification.json`, `live-acceptance.json`,
`focused-tests.log`, and `focused-tests.exit`.
