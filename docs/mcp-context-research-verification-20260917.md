# Context editing and research verification — 2026-09-17

## State

Implemented and connected on `feat/mcp-app-bridge`: explicit partial context editing, externally supplied research review, app research, paginated proposal inspection, and selective atomic application. The implementation is not yet an all-gates or live-provider acceptance closeout. See `mcp-context-research-testing.md` for the contract and limitations.

User library, original images, authentication and model/provider settings were not modified in this work session. The normal app was not restarted. All successful mutation tests used isolated synthetic libraries. No actual paid search/model requests were made.

## Fixes and commits

- `eded7e39`: fixed a reproduced research/apply deadlock. App research previously held the work-context read activity while waiting on a proposal queue whose current apply needed that activity's write lease. Only the engine now runs inside the app activity; cleanup finishes and leases are released before queued proposal publication. Revision checks after release reject concurrent real changes. Both previously failing concurrency cases passed after this change.
- `fe1b754e`: separated policy responsibilities to meet function limits, removed non-null assertions, fixed research-target union typing in tests, and kept safe URL validation explicit.
- `c9f0c8d2`: integrated native context acceptance. Preview is checked against stable context content AND actual on-disk library bytes, because absent context files generate transient default timestamps on reads.
- `7369f982`: covered research operations and actual context session composition, and registered all 35 output schema names in the contract test.
- `7e4bf8d1`: retained Tavily credit usage for successful research with no proposed changes. A new assertion first failed with `undefined` instead of the consumed credit, then passed after the fix.
- `d46aef01`: registered 11 newly measured Windows context modules and updated the exact introduced-file inventory to 773. Existing floors, deleted-file inventory and historical provenance were preserved.

## Confirmed runs

1. Research deadlock regression before the fix: two failures (research and queued application could not settle).
2. Post-fix context/research focused suite: 19 passed across five files. Including selected-erasure regression checks: 23 passed across six files.
3. Renderer, Electron and script type checks passed in the recorded static run. Changed production files and native scripts passed focused lint.
4. Windows app build completed successfully (`build.exit = 0`).
5. Native Electron rerun completed with `native-second.exit = 0` and `PASS MCP native smoke finished`.
   - 235 hostile input checks across 34 production tools.
   - Actual context tools previewed and applied glossary, character, rules and page memory together.
   - Original page data and image bytes stayed unchanged.
   - Exact retries did not repeat writes; stale previews/applications were rejected.
   - Synthetic external research retained reference metadata, applied only the selected glossary change and preserved the unselected character, aliases, note and origin.
   - Existing OCR/translation proposal, erasure, renderer and explicit-file tests also completed.
   - Native heavy inference and research references were fixtures, NOT actual internet/provider acceptance.
6. Last retrieved complete coverage run (`coverage-second.log`): 7,363 passed, one failed, 11 skipped; 878 passed test files, one failed, one skipped. The sole test failure was the missing 11-file coverage inventory. The inventory was subsequently registered, and the targeted credit/inventory test command passed.
7. The final full coverage run was started after commits were pushed, but its output/exit file could not be retrieved because Remote Desktop Commander commands and file reads timed out. Do not replace the last observed count with an inferred successful total.

## Coverage evidence

The new-file measurements came from the Windows full run at `7369f982`.

- Local evidence: `.tmp/mcp-context-finish-20260917/context-coverage.json`
- SHA-256: `83d751f52b2f1a8232e233c8f8c3dc94b1489817807bccc3883c97a34bd3894f`
- Registered source files: context edit policy, proposal service, research policy/service, context editing facade, context edit scope, research adapter/tool, context session/tools, shared context schema.
- The research service, session composition and shared context schema measured 100% in all four metrics. Other new files retain their actual measured values; they are not reported as full coverage.

An existing floor still fails in `src/main/application/mcpJobJournal.ts`: statements 35/36 and branches 32/33 versus the existing 100% requirements. The missing case is rejection of a research-shaped persisted target mislabeled as a page operation. An attempted regression-test write for this case was rejected before execution by the tool safety check; it was not rerouted or marked applied. The original floor remains unchanged.

## Remaining integration gates

The latest retrieved `npm run check` did not pass all 26 gates. Types, formatting and the refactored focused lint have passed, but these direct-dependency limits still require explicit review:

| File | Measurement | Current ceiling |
| --- | --- | --- |
| `src/shared/appActivityTypes.ts` | imported by 28 | 26 |
| `src/shared/pageRevision.ts` | imported by 45 | 44 |
| `src/main/application/mcpEditPolicy.ts` | imported by 38 | 31 |
| `src/main/library.ts` | imports 13 / imported by 38 | 12 / 36 |
| `src/main/mcp/mcpPageOperationSession.ts` | imports 18 | 17 |

The public library facade also needs review of the new `./library/libraryContextEditingFacade` source in its re-export boundary. A combined policy/configuration review read was rejected by the tool safety check. These configuration changes were not applied by another route. No global gate was disabled, and no forwarding module was introduced to hide dependencies.

## Live connection and resume point

Two `carrot_get_capabilities` attempts on the current chat connection failed with OAuth HTTP 503 (`OAuth token request failed, try again later`). The new context tools and an actual configured research provider were not invoked from this chat. Native isolated success does not establish live client/provider success.

GitHub confirmed the code/coverage checkpoint at `d46aef01`. The final Windows working-tree/remote comparison was not available after the device stopped responding; do not claim a newly verified clean/synchronized local checkout.

Resume by checking the existing worktree and `.tmp/mcp-context-finish-20260917/coverage-final.log` plus `coverage-final.exit`, addressing the pending gates without lowering historical requirements, then running the full check and native acceptance. After a normal app restart and client tool refresh are appropriate, perform live acceptance on a disposable work only. Preserve existing auth/data/settings; do not bypass a failed connection using extracted credentials.
