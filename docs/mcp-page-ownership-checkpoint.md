# MCP page ownership checkpoint — 2026-09-16

Branch: `feat/mcp-app-bridge`; starting commit `583fc4c4`.

## Scope implemented in this checkpoint

- Synchronous external-reading and text/style/order edits acquire the existing native page handoff and content lease.
- OCR declares the shared local-model resource and acquires its target page before recognition.
- PNG export owns only its target page, not the entire library or local-model resource.
- MCP erasure obtains its page before engine preparation and retains ownership through native job finalization.
- Existing UI handoff/save acknowledgment and activity-derived editor locks are reused; no second GPU queue or lock system was introduced.
- Unrelated pages remain available for lightweight edits. Same-page saves and chapter deletion are blocked at the actual library activity boundary.
- Synchronous calls monitor caller authorization while awaiting handoff; cancellation waits for their callback/finalization before releasing the native activity.
- This does not add parallel batch execution or automatic resume.

## Verification so far

- Targeted suite: 418 tests in 53 files passed (including native orchestration, library gate and renderer handoff regressions).
- Renderer/Electron typechecks and changed-source ESLint passed.
- Regression tests cover dirty-save refusal, cancellation during handoff, permission loss, stale revisions after UI save, unrelated-page writes and ownership retention during delayed cleanup.

## Explicitly incomplete: model shutdown guarantee

The proposed resource-pool update was blocked by the tool safety check and did not run. Production `leasedIdleResource`, Flux/Koharu pools and their 30-second idle retention remain unchanged. Disposal-failure behavior was reproduced, but **this checkpoint does not guarantee actual local-model unload or prevent all post-cleanup-failure model transitions**.
The isolated regression patch is preserved locally at `.tmp/mcp-page-model-20260916/pending-model-lifecycle-regressions.patch`, outside the active test suite.
A native smoke-fixture adaptation was also not completed after its refactor request was blocked. Its experiment is preserved in the same directory as `pending-native-page-ownership-fixture.patch`; the original smoke script remains unchanged and needs a synthetic UI handoff acknowledgment for this new ownership path.

No user pages, model settings, authentication files or running application were changed by the tests. Do not claim the whole page/model bundle is complete until real disposal barriers and native acceptance are finished.

## Follow-up hardening

- Synchronous page scopes also receive the desktop MCP session shutdown signal; stopping MCP cancels pending UI handoff instead of allowing a late edit.
- Two unrelated text-edit scopes can coexist with a model job on a third page. They never acquire a model-runtime lease.
- Renderer lock derivation is tested for the new `mcp-edit` kind: target only, retained after data save, released only with activity removal.
- The public library facade has one new, direct post-handoff reader (31 → 32). Only this specific fan-in allowance changed; no general limits or rules were disabled.
- One new source inventory entry was added. Initial focused V8 measurement for `mcpPageEditScope.ts` was 100% lines/statements/functions/branches; all existing manifest records and provenance were preserved.
- Initial measurement SHA-256: `5b00d87a22bf7eab7dd9962bd6923bdd670536a7dbecacac7465143a20909b03a8`.
- First broad check stopped at the new facade consumer count. The next check passed 7,160 tests but stopped at the source inventory count (743 → 744); neither run is reported as successful overall.
- Final acceptance must be recorded after rerunning with the inventory and session-cancellation regression updates.
