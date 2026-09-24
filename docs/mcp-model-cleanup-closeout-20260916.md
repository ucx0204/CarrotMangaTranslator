# MCP page ownership and model cleanup closeout — 2026-09-16

Branch: `feat/mcp-app-bridge` only. Verified implementation/test commit: `92bc1da804eeef06ba48f73eb9cf1c3af31f738f`.

## Status

The scoped page-ownership/model-lifecycle implementation is complete and passes the repository check and native Electron acceptance. This supersedes the incomplete model/coverage/native status in `mcp-page-ownership-checkpoint.md`. No batch scheduler, new OCR engine, alternate inpainting algorithm, release or additional branch was introduced.

The core changes were published through GitHub and verified in the existing Windows review worktree. Local regression/coverage corrections were also committed to the same remote branch. Existing user pages, originals, authentication, model settings and the running desktop app were not modified or restarted. The rebuilt code takes effect when that app is normally restarted.

## Ownership and lifecycle guarantees

- Synchronous MCP text/style/placement/order edits and external readings use the existing page handoff and content lease. Unsaved editor changes are handed off; stale requests conflict instead of overwriting them.
- OCR reserves the shared model-runtime resource and its target page before recognition. Erasure reserves its page before model preparation and retains it until native finalization settles. PNG owns its target page, not a global model slot.
- Unrelated lightweight page edits may coexist; same-page edits and conflicting chapter mutations remain blocked by existing storage/activity policies, not merely by disabled UI controls.
- The existing inpainting job holds one lease across its fixed sequential pages. The public workload release now awaits native cache disposal rather than leaving the engine in the low-level 30-second idle cache. Lower-level idle reuse is not a promise that a completed MCP workload keeps its model resident.
- A different model cannot be admitted while a registered native release is pending or failed. The shared app activity gate and model acquisition paths enforce the same fence. Lightweight work that needs no model can still proceed on unrelated pages.
- Failed model handles are retained. An acquire must not silently retry an uncertain disposal or replace a still-closing worker. Only acknowledged cleanup clears the barrier; an unrecoverable native-session release remains blocked rather than pretending it succeeded.
- A committed page and a cleanup failure are distinct outcomes. Erasure reports `partial` with `cleanupFailed` and the saved revision when saving actually completed. Failed setup must not report a committed page. No raw process errors/paths are copied into public results.
- Cancellation identifies the operation's own native job even if another lightweight job appears first in the legacy current-job view. It does not cancel that unrelated job or release ownership before finalization.

## Additional defects reproduced and fixed

### Lost WASM worker handle

The WASM error/exit callback discarded its worker reference before the owning finalizer acknowledged termination. Two regressions failed on the old implementation. `c5140e01` retains the failed handle, prevents replacement inference and awaits `terminate()` through the cleanup barrier. Tests cover delayed termination, termination rejection/retry, asset-resolution races and malformed/native error results.

### OCR cancellation before actual process exit

The command runner rejected immediately after requesting process-tree termination on cancellation, timeout or stream failure. Consequently the OCR active-operation set could become empty before the model process closed. All five initial regressions reproduced this; synchronous close could also turn cancellation into false success.

`b52687b8` records the original stop reason before requesting termination and settles only from the actual child `close` event. A failed kill request or termination exception does not release page/model ownership. Repeated errors do not trigger duplicate termination, and cancellation remains cancellation even if close reports exit code zero. Seven final regressions cover deferred close, failed termination and cancellation during spawn. Existing actual subprocess cancellation/security/pipe tests also pass.

If the operating system never acknowledges child closure, the operation deliberately remains owned/pending rather than declaring cleanup complete and loading another model. There is no new automatic force-recovery mechanism in this milestone.

## Verification on Windows review worktree

- `node scripts/check.cjs`: **all 26 stages passed**, exit 0.
- Final full test execution: **7,195 passed, 0 failed, 11 existing skipped**.
- Three typechecks, formatting, lint, module/mock boundaries, architecture, duplicates, dead code and sealed coverage gates passed.
- Build, editor/export pixel parity, image protocol, renderer bundle and preload bundle checks passed.
- Final `mcp-electron-smoke.cjs` on isolated port **38685**: exit 0 and `PASS MCP native smoke finished`.
- Native acceptance covers actual page handoff, editable readings/styles/order, selected erasure preserving the other region, source crops, saved context, read-only review/preflight, rendered PNG, metadata-only polling, explicit file access, revoked links and encrypted history.
- Hostile native HTTP matrix: **162 checks across 23 production tools**.
- Focused regressions prove model admission blocking during delayed/failed cleanup, unrelated lightweight work, stale-page refusal, correct job cancellation and preserved saved results.
- The original coverage floors/provenance were not lowered. Four newly touched source records were added using observed coverage; source inventory is **753 existing / 745 introduced / 10 deleted**. The new records are the Koharu pool, leased resource pool, anime detector pool and model cleanup barrier. WASM coverage was raised with real protocol/lifetime regressions instead of changing its historical floor.

Earlier failing formatter, fixture-spy, legacy swallowed-disposal expectation and missing-inventory checks were fixed and rerun; they are not reported as successful runs. Intermediate patch publication failures were corrected; only applied source is part of the final acceptance.

## Evidence and reproduction

All paths below are relative to the existing review worktree:

- `.tmp/mcp-model-closeout-20260916/check-ocr-final.log` and matching `.exit`.
- `.tmp/check-results/vitest.json` and `.tmp/check-timings.json`.
- `.tmp/mcp-model-closeout-20260916/native-ocr-final.log` and matching `.exit`.
- `.tmp/mcp-model-closeout-20260916/wasm-before-fix.log`, `wasm-after-fix.log`, `wasm-protocol-tests.log`.
- `.tmp/mcp-model-closeout-20260916/ocr-close-before.log`, `ocr-close-after.log`.
- `.tmp/mcp-model-closeout-20260916/coverage-observed.json` records the actual source measurements used for only the newly added floor entries.

```powershell
node scripts/check.cjs
$env:CARROT_MCP_SMOKE_PORT = '38685'
node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs
```

Use a free isolated port and let the smoke fixture close its own server; do not terminate the user's application or alter its approval store to make the test pass.

## Explicit acceptance limits

Native page tests use a deterministic image-inference boundary while retaining the actual app masks, transactions, activity system, renderer and output logic. Worker-lifecycle tests replace only the native process/worker boundary; the command security tests additionally execute real subprocesses. This is not a measurement of every installed OCR/inpainting model's VRAM usage, a real-model quality assessment, a macOS hardware run, or a guarantee that other programs on the PC consume no GPU memory.

The connected Carrot capability call succeeded during this continuation, but the live user app was intentionally not restarted into the new build or used to mutate originals. No new model was downloaded. Other batch/undo/research/import/ZIP features remain outside this completed bundle.
