# Chapter text batch: live reconfirmation

Source/worktree baseline: `68ba68f66ecd433b03a212d4c736c4d639afac35` on `feat/mcp-app-bridge`.
The implementation was already complete. This run did not rewrite it or restart the app.

## Checks performed in this continuation

- All seven search/batch tools were actually called through the updated live MCP connection.
- A snapshot-paginated `HELLO` source search found three candidates. Full blocks and saved context were read; only two fixture pages were selected, leaving neighboring dialogue untouched.
- Batch `7fd7b401-2780-430f-ac5a-2268c65b97d5` completed apply, undo, redo and final undo. Every accepted action was polled to a terminal state.
- Preview left all 14 backed-up fixture files byte-identical. Apply changed only two `translatedText` fields and ordinary timestamps.
- Both applied pages were explicitly rendered and showed the chosen Korean greetings. No OCR, translation model, erasure, formatting or research ran.
- A pre-edit search snapshot was rejected after mutation. An older action ID could not cancel the newer redo. Cancelling a completed action left it completed.
- Replaying the old undo after redo returned a historical receipt; independent file inspection confirmed that it did not undo again.
- Focused tests were rerun: 33 tests in five files passed, process exit 0.
- The earlier full-check and native logs were independently reread, including both exit-code files (0). Their 26-stage / 7,469-pass results were NOT newly rerun in this continuation.

## Preservation and evidence

Only `MCP Edge Audit 20260916 / Disposable synthetic pages` was modified. Final work/chapter diffs contain modification timestamps only; all blocks, styles, ordering, images, masks, caches and context are unchanged/restored. Backups and action/export records remain.

Local evidence: `.tmp/mcp-text-batch-confirm-20260918-014915/` (`manifest-before.json`, `applied-diffs.json`, `confirmation.json`, `focused.log`, `focused.exit`, `work-before/`).

The live scenario covers two pages, not maximum batch capacity or arbitrary vague-intent quality. Active-save cancellation, permission revocation and generated-lettering boundaries are covered by automated tests, not forced into the normal app here. See `mcp-text-batch-closeout-20260918.md` for the earlier three-page and partial-failure acceptance.

Before/final PNG exports were newly requested and polled to completion; no file-attachment retrieval was called. App-returned full SHA-256 and byte counts match:

| Page         | Bytes | SHA-256 before and after restoration                             |
| ------------ | ----: | ---------------------------------------------------------------- |
| external.png | 14908 | 89fb027ab3520f857ef73a2c3f4c83b90ba17d2a726bb43c5e52d904a2a84c3c |
| render.png   | 12297 | 00334b6123c8b6451ec87fc3cf15ad6629508375eafc17eccfc1d470ba978e35 |

These are app-reported export hashes, distinct from the independent PC byte comparison of all 14 fixture files described above. No general-work data, credentials, model settings or tunnel settings were changed. No implementation defect was observed in the tested batch paths.
