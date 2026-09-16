# MCP page ownership checkpoint — 2026-09-16

Only branch: `feat/mcp-app-bridge`. Base: `583fc4c4`.
Published implementation: `d5b99b27`, followed by `a26468a8`.
Status: page ownership implemented and regression-tested; the complete page/model bundle is NOT finished.

## Implemented

- Synchronous external readings and text/style/order edits acquire the existing native page handoff and content lease.
- OCR declares the shared local-model resource and acquires its target page before recognition.
- PNG export owns its target page, not the entire library or the model resource.
- MCP erasure acquires its page before engine preparation and retains page ownership through native finalization.
- Existing UI handoff/save acknowledgment and activity-derived editor locks are reused; no second lock or GPU queue exists.
- Two unrelated lightweight scopes may coexist with a model task on another page. Same-page storage access and conflicting chapter deletion are rejected.
- Cancellation waits for the callback/finalization to settle before releasing ownership.
- Synchronous scopes observe both caller authorization and desktop MCP-session shutdown.
- Erasure cancellation identifies the newly admitted native job, not an unrelated first job in the activity list.

## Verified on source a26468a8

- Full test execution: **7,165 passed, 0 failed, 11 existing skipped**.
- Three typechecks, lint, formatting, architecture, mock-boundary, duplicate and dead-code checks passed.
- The overall `npm run check` did NOT pass: it stopped at the production coverage gate, before the build/remaining verification stages.
- Coverage failures: `mcpErasureAdapter.ts` statements 47/50 (94%) against 36/38 (94.73%); functions 12/13 (92.3%) against 9/9 (100%). Do not lower these historical floors.
- Page regressions cover handoff acknowledgment, dirty-save failure, stale revisions, session stop, caller loss, unrelated-page writes, model exclusion and delayed cleanup.
- Tests exercise actual activity/ownership policies and injected processing boundaries; they do not prove real GPU-model unload or the full live UI flow.

## Remaining model-lifetime work (not applied)

The resource-pool edit request was denied by the tool safety check. Production `leasedIdleResource`, Flux/Koharu pools, disposal behavior and 30-second idle retention were NOT changed. Do not claim guaranteed unloading or safe transition after a disposer fails.
The reproduced disposal-failure behavior and proposed tests are preserved at `.tmp/mcp-page-model-20260916/pending-model-lifecycle-regressions.patch`; these are not part of the active test suite.
Complete actual session/worker disposal acknowledgment and cross-model admission barriers before declaring the user's model-lifetime requirement fulfilled. Retain one model for its fixed sequential workload only; release it before another model and after final work. Do not add a batch runner here.

## Remaining native and coverage acceptance

A native fixture-refactoring request was denied. The experiment is preserved at `.tmp/mcp-page-model-20260916/pending-native-page-ownership-fixture.patch`.
The original `scripts/mcp-native-page.cjs` was restored and remains unchanged. Its isolated fake window needs a test-only UI handoff acknowledgment for the newly scoped erasure/export route; do not interpret a waiting handoff as a production model failure.
An additional regression-test write for erasure cancellation behind an unrelated lightweight job was also denied. The inspected production cancellation correction is published, but that dedicated regression still needs completion.
The full native Electron/page-flow acceptance and live user-model tests were not run for this checkpoint.

## Inventory and evidence

Only one new public-library consumer was added (31 → 32), with an explicit composition reason. Generic budgets and all existing coverage floors/provenance are unchanged.
One measured source floor and its source-inventory increment (743 → 744) were added for `mcpPageEditScope.ts`.
Logs and measurements: `.tmp/mcp-page-model-20260916/`.
Latest broad check log: `check-a26468a8.log`; detailed test results: `.tmp/check-results/vitest.json`.
Initial focused-scope coverage JSON SHA-256: `5b00d87a22bf7eab7dd9962bd6923bdd670536a7dbecac7465143a20909b03a8`.
Historical checks exposed the new reader count, inventory count and missing regression coverage; none were reported as overall success.

## Working-copy safety

User pages, original images, authentication, model settings and the running app were not modified or restarted. Tests use isolated fixtures. No release, new branch, force push, shared queue replacement or model-download task was started.
Resume from this branch and complete the model barrier, remaining coverage and native acknowledgment fixture before marking the entire bundle complete.
