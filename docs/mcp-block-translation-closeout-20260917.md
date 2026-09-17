# Single-block translation closeout — 2026-09-17

## Current result

The implementation, full Windows repository gate, isolated Electron acceptance and actual configured Gemma proposal/application/restoration have passed. The normal application was gracefully restarted from the synchronized `96357c377537e02eb3e431c55c4f19b54216ae6e` worktree. This supersedes the unresolved integration list in the earlier checkpoint.

No new provider, batch executor, image input, OCR, inpainting or automatic application was added during closeout. The translation proposal still uses the existing page ownership, model cleanup and explicit revision-checked translation editor.

## Repository checks on the user PC

- `npm run check`: all 26 gates passed, exit 0, 148.25 seconds.
- Full Vitest report: 7,339 passed, zero failed, 11 existing skipped; 7,350 tests total.
- TypeScript checks, lint, architecture, duplicate/dead-code checks, measured coverage, Windows build, artwork pixel parity, image protocol and bundle boundaries passed.
- Separate Electron MCP smoke on unused port 38685: exit 0 and `PASS MCP native smoke finished`.
- Native hostile-input matrix: 203 checks across 29 production tools.
- Native text-only proposal test verified unchanged observation snapshot, one generation/release, duplicate receipt, translation-only application/restoration, changed/restored raster and intact source/inpainting images. Its model response is synthetic; real Gemma evidence is separate below.

Five direct-dependency exceptions were documented at `b8aef6e0`; global architecture limits were not changed. Six new modules received measured coverage records at `96357c37`, and the exact introduced-file inventory changed from 756 to 762. Existing coverage ratios and historical provenance were not lowered or replaced. See `mcp-block-translation-coverage-20260917.md` for exact measurements and the source summary hash.

CI now also runs `npm run check` and preserves the full log, exit code and coverage summary. At this document's initial write, run 35185251402 had passed build, native smoke and UI checks; its remaining CI result is independent of the completed local gate above.

## Actual connector acceptance

The existing disposable synthetic `render.png` page was used, never an ordinary work. Japanese test source `今日はいい天気ですね。` produced `오늘은 날씨가 좋네요.` with the user's configured Gemma model and `contextMode: saved`. Saved rules were present, but this fixture has no glossary, characters or memory entries; this is not a live populated-glossary or multi-page memory quality test.

Before deployment, job `215f4f78-1827-4508-9cf0-95442cbf45e2` completed with `pagesChanged: 0`. Exact replay returned the same receipt; changed context mode under the same request ID was rejected. A stale page revision could not apply its proposal. Explicit application and original source/translation restoration succeeded.

After the graceful restart, job `7b101b2d-704d-499b-87e4-18ac8cb59ba0` repeated the real saved-context translation on the rebuilt application. It completed with one request and no page changes. The actual `chapter.json` bytes before and after proposal generation were identical. The proposal was separately applied, then both original source and translation were restored through MCP. Final readback matched revision `page-v1:e77b3d32a89a69ec`, with both blocks, source/display geometry, stored typography and reading order intact.

The earlier completed job remained queryable after restart but had `proposalExpired: true` and no source/proposal text. Normal startup temporarily interrupted the public connection; a later successful server-info response confirmed the same server/data-profile IDs and a new runtime ID. Authentication was not reset or re-registered.

Remote process inspection after the final real model job found no `llama-server.exe` process. Only the normal MCP listener remained on port 38475; the isolated test listener 38685 was closed. This checks process release, not that unrelated GPU memory is zero. No external paid provider or Codex generation was used in the live tests.

## Preservation and evidence

Before synchronization, the two local native-test edits were copied into `.tmp/mcp-translation-final-20260917T050544Z/` and preserved in the named Git stash `mcp-translation-closeout-native-pre-sync-20260917`. One file already matched remote; the other differed only in the order of a preview assertion. Neither copy nor stash was discarded.

Before the final app restart, 11 fixture chapter/image/mask/cache files were backed up under `fixture-before-restart` in that same report directory. Proposal generation was compared byte-for-byte successfully. A later optional recursive apply-diff report request was blocked before execution and was not retried through another route; final restoration was verified through MCP readback and its canonical revision instead. Do not claim that this optional whole-file apply comparison ran.

Logs and reports in `.tmp/mcp-translation-final-20260917T050544Z/`:

- `coverage-current.log`, `coverage-summary.json`, `new-module-measurements.json`: measured registration evidence before the inventory fix.
- `full-check.log`, `full-check.exit`, `vitest-final.json`, `coverage-final.json`: complete passing repository result.
- `native-final.log`, `native-final.exit`: complete fresh Electron acceptance.
- `app-restart.log`: normal development app rebuild and launch.
- `before-sync.patch`, native script copies and `fixture-before-hashes.json`: preserved checkpoint and fixture baseline.

Ordinary works, authentication and model configuration were not modified. The synthetic source/translation were restored; normal modification timestamps, job receipts and backups remain. No image/file attachments were requested.

## Scope limits

This closes single-block text-only proposal generation and explicit application. Live tests cover configured Gemma, not every external provider or model. Context changes during generation discard the result, but applying later through the generic editor checks the page revision only: review saved context separately; no atomic context-version approval is claimed. Proposals expire on restart while safe job metadata persists. Do not add fallback, parallel local models or automatic writes when extending this feature.
