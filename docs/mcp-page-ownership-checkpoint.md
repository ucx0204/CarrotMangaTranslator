# MCP page ownership checkpoint — 2026-09-16

Only branch: `feat/mcp-app-bridge`. Original page-ownership base: `583fc4c4`; initial implementations: `d5b99b27`, `a26468a8`.

## Current status

**The scoped page-ownership and acknowledged-model-cleanup bundle is implemented and validated.** The final tested source/regression commit is `92bc1da804eeef06ba48f73eb9cf1c3af31f738f`.

See [model cleanup closeout](mcp-model-cleanup-closeout-20260916.md) for exact guarantees, failure behavior, evidence and acceptance limits. The incomplete model/coverage/native notes from the initial checkpoint below are historical, not current remaining work.

## Implemented

- Synchronous external readings and text/style/order edits acquire the existing native page handoff and content lease.
- OCR declares the shared local-model resource and acquires its target page before recognition.
- PNG export owns its target page, not the entire library or model resource.
- MCP erasure acquires its page before engine preparation and retains ownership through native finalization.
- Existing UI handoff/save acknowledgment and activity-derived editor locks are reused; no second lock or GPU queue exists.
- Unrelated lightweight scopes may coexist with a model task on another page. Same-page storage access and conflicting chapter deletion are rejected.
- Cancellation waits for the callback/finalization to settle before ownership is released.
- Synchronous scopes observe both caller authorization and desktop MCP-session shutdown.
- Erasure cancellation targets the newly admitted native job, not an unrelated first job in the activity list.
- Public inpainting workload release awaits model disposal. One model may be reused within the already-fixed sequential workload, but completed workloads do not leave it resident under the pool's idle grace period.
- Pending/failed model cleanup blocks new app model admissions. Failed resources remain tracked instead of being silently replaced.
- Native WASM worker failures retain their handle until termination acknowledgement. OCR cancellation/timeout/pipe failure waits for actual child closure rather than equating a kill request with model exit.
- Saved page results are retained and reported separately when final resource cleanup fails.

## Final verification

- Full repository check: **26 stages passed**, including build and renderer/export validation.
- Full tests: **7,195 passed, 0 failed, 11 existing skipped**.
- Native Electron MCP smoke: exit 0, final completion marker present.
- Native hostile-input matrix: **162 checks across 23 tools**.
- Existing coverage floors and generic architecture limits are preserved. Newly touched source floors were added from actual measurements only.
- Logs: `.tmp/mcp-model-closeout-20260916/`, especially `check-ocr-final.log` and `native-ocr-final.log`.

The native page fixture acknowledges handoff only for its own synthetic pages. This does not bypass the live app's renderer/user handoff. Heavy inference is deterministic in that fixture; real GPU-model quality/VRAM measurement and hardware-specific macOS execution were not part of this acceptance.

## Historical initial checkpoint

At `a26468a8`, 7,165 tests passed, but the overall check stopped at the erasure coverage gate. The model-lifetime changes, extra cleanup/cancellation regressions and native handoff fixture had not yet been applied. Those source/test/native gaps are now closed; do not resume by reapplying old `.tmp/mcp-page-model-20260916/pending-*.patch` experiments.

The initial check logs remain under `.tmp/mcp-page-model-20260916/` as historical evidence. Earlier tool/pipeline failures are not counted as successful validation runs.

## Working-copy safety and next scope

User pages, original images, authentication, model settings and the running app were not modified or restarted for this closeout. No release, extra branch, force push, batch scheduler, automatic recovery agent or model-download task was started. A normal app restart is required to load the rebuilt code.

Future batching, image undo/redo, area OCR, research, import and ZIP remain separate features. Preserve the one-model sequential-workload policy, page ownership and explicit status-versus-file separation when extending them.
