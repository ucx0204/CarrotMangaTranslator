# Bundle 9: fixed multi-work research continuation

Status: IMPLEMENTED, REGISTERED AND AUTOMATIC/NATIVE VERIFICATION PASSED.
Bundle 9 is complete within the explicit bounds below; live acceptance remains
pending. Continue only on `feat/mcp-app-bridge` in the MCP-Review worktree.
Starting checkpoint: `d32adbf4`. Final verified source/test/configuration:
`1e5c8de69e6663cb7422a12d7a0677de817c7d9c`.
Next implementation is bundle 10, file/web import and library organization.
Do not redo context migration, memory refresh, retained research or bundles 1-8.

## Connected behavior

Eight new tools compose fixed research plans with the existing native context
research executor, operation journal and encrypted retention storage:

- `carrot_prepare_research_batch`
- `carrot_get_research_batch`
- `carrot_list_research_batches`
- `carrot_run_research_batch`
- `carrot_resolve_research_hold`
- `carrot_pause_research_batch`
- `carrot_cancel_research_batch`
- `carrot_discard_research_batch`

Preparation takes one to ten distinct existing works, one anchor chapter each,
current context revision, the existing complete-work reference snapshot, explicit
research title/engine, title confirmation and whole-work spoiler permission.
The ordered work list is fixed; later imports never join implicitly. Preparation
stores private metadata but performs no research, model call or artwork edit.
The existing shared retention policy is seven days, 256 records and 1 GiB, including
this new work-level record kind. It is not unlimited archival. Larger libraries
require explicitly selected groups; a plan never silently expands its work list.

Unconfirmed titles and spoiler-limited work stay held. This is caller-reviewed
identity, not an automatic claim to distinguish every similarly named work. The
existing researcher may use saved text from the entire work and external spoilers;
it does not implement a chapter-bounded search. Resolve a hold only after an
explicit title and whole-work permission are available, then run separately.

Run/resume needs the current plan version, a new action request ID and explicit
external-service permission. Local Tavily analysis additionally requires asset
preparation permission. Fixed limits allow one to thirty total work attempts,
including explicit retries. An attempt is not a search, token or currency budget;
each native research run retains its configured provider/model/account limits.
No new provider fallback, GPU scheduler or credential-management tool is added.

Each child is an existing `contextResearch` operation. Work is sequential, holds
native leases through cleanup, and observes the existing incomplete-cleanup fence.
The original prepared reference snapshot reaches native execution and retained
proposal admission. Settings are captured for each run and fingerprinted privately;
a changed setting at resume requires restoration or a new remaining-work plan.
No settings or secrets are returned by the public batch results.

Successful reviews remain independent retained proposals. Existing
`carrot_get_context_proposal` and `carrot_apply_context_proposal` provide inspection
and explicit selected application; existing context recovery provides Undo/Redo.
Research never becomes page-read memory or automatically changes any glossary,
character, translation, block, image, mask or font. A full catalog replacement
still uses the previously implemented explicit context migration/replacement path.
The total registered strict output contracts is now 152, up from 144.

## Interruption, retry and ownership

An attempt is checkpointed before native execution; its job ID and terminal
proposal/no-change/failed result are checkpointed afterward. A reconstructed running
plan is interrupted, never automatically resumed. Before any explicit retry the
runtime looks for an existing native child receipt and retained proposal with the
same owner/request/target/evidence. Already completed work is not run again.
Unknown attempts need explicit `retryFailed=true`. Unavailable retained reviews do
not silently trigger new paid research. Known completed IDs still require a fresh
owned/unexpired proposal lookup before reading/applying.

Known search/source/Tavily usage is summed; failed or interrupted calls without a
confirmed usage receipt count as unknown rather than zero. Preflight rejection
before admitting a native child can accurately record zero. Partial failures
preserve successful works and allow remaining eligible works to proceed. Settings,
permission, cleanup or storage failures stop the parent and preserve checkpoints.

Pause allows the current child to settle before stopping. Cancel signals only the
owned admitted child and waits for cleanup. Neither is Undo. Parent completion is
not visible until final checkpoint publication settles. Plan disposal is allowed
only after settlement and deletes that plan, not its separate proposals/recovery.
The generic retained-record discard rejects research plans and directs callers to
the dedicated control path. Other approved owners cannot inspect or control them.
The existing native retirement method optionally stages index removal in the same
transaction; existing callers without that option retain their original semantics.

Reads require `carrot.read`; preparation/execution/control require `carrot.read`
and `carrot.process`. Context application retains its separate edit permission.
A run requires a verified continuing job authorization, not a retained HTTP request
whose response has already ended. No raw path, serialized native record, callback,
credential, arbitrary tool name or settings object is accepted by these tools.
New conversations using the same approved connection can resume the plan; this
change does not add transfer of research plans to a different approved owner.

## Final verification

All 26 repository gates passed with actual process exit code zero at `1e5c8de6`.
The complete suite passed **8,156 tests, zero failures and 11 inherited skips**.
The MCP subset passed **1,337 cases across 213 files**. New batch-specific checks
passed **22 cases across six files**. Renderer/Electron/JavaScript types, lint,
formatting, dependency/structure, duplicate/dead-code rules, mock boundaries,
coverage inventory/floors, Windows build, native artwork/image-protocol and renderer/
preload bundle checks all passed in the same sequence.

Final gate interval: `2026-09-20T10:58:00.971Z` through
`2026-09-20T11:02:26.296Z`. This run used the existing process-local
`MGT_VITEST_MAX_WORKERS=8` option, with no parallel standalone build/native smoke.
The checked-in default worker policy, test assertions, skips and 15-second test
limit were not changed. This is not a claim that the earlier 12-worker run passed.

That earlier full run passed 8,148 cases but failed seven: four 15-second timeouts,
two later fixture errors in timed-out files, and the then-unregistered seven-module
coverage inventory. Its V8 measurements and all failure logs are preserved. The
52-case isolated regression rerun passed without changing the timed-out tests.
The final full run passed all of those tests and every inherited coverage floor.
No precise common root cause of the earlier timing failures is asserted beyond
the observed configuration and results; they were not hidden by focused success.

All **1,707 inherited coverage records, provenance and deletion records remain
identical** to `d32adbf4`. Only seven genuinely new production modules were registered
from measured V8 totals/covered counts, bringing the manifest to **1,714 records**.
Their initial measurement came from the complete report-on-failure run and was
then enforced successfully against the final passing suite. No inherited floor
was reduced. Eight exact dependency counts for existing native/shared authorities
were documented; global architecture limits were unchanged.

Native Vitest fixtures execute real work files, whole-work evidence, native activity
ownership, cleanup boundaries, proposal conversion, encrypted record storage,
transactions, operation journals and public tool/output validation. Only the external
research provider/model response and established Electron/encryption fixture boundary
are substituted. OAuth/HTTP tests prepare held plans, reconstruct the server, test
scope/owner isolation and revoke a real test grant during encrypted publication.

Cases cover sequential works, held titles/spoilers, per-work failure, explicit retry,
no-change completion, unknown interruption, parent-checkpoint loss reconciliation,
manual source edits, settings changes, attempt limits, pause/cancellation and blocked
final publication. Strict checkpoint invariants, pagination, independent discard
and the retained index's original page-record limits are also verified.

The added actual-Electron scenario passed with **actual child exit code 0**, both
`PASS native multi-work research plan -> OS-encrypted restart` and
`PASS MCP native smoke finished`. Two held works exercise real OS-encrypted plan
storage, session reconstruction, exact replay, explicit hold resolution without
inference, owned disposal and original preservation. The separate test listener
on port 38692 was confirmed closed. Native source was `6cc2e84a`; production code
and both relevant native scripts were unchanged at final verified source `1e5c8de6`.

Initial fixture failures remain documented: an unrelated import runtime was missing
from the unit environment, renderer-only data URLs were accidentally seeded into
stored records, a retained proposal was initially checked with the session-only
inspector, and a derived generation setting was normalized back. These tests now
use valid saved files, the public retained lookup and a real language-setting change.
No production protection or existing assertion was weakened to fix those fixtures.

Evidence in the review worktree:
`.tmp/mcp-research-batch-full-check-3.log`,
`.tmp/mcp-research-batch-final-evidence.json`,
`.tmp/mcp-research-batch-final-vitest.json`,
`.tmp/mcp-research-batch-final-coverage.json`,
`.tmp/mcp-research-batch-final-timings.json`,
`.tmp/mcp-research-batch-verified-source.json`,
`.tmp/mcp-research-batch-native.log`,
`.tmp/mcp-research-batch-native-result.json` and earlier focused/failure logs.
Final documentation commits must be compared against `1e5c8de6` to verify that
source, tests and scripts have not changed after the successful gate sequence.

## Next boundary

Bundles 1-9 are implemented, registered and automatically verified, with live
acceptance deferred. Next is bundle 10: existing file/web import services, reviewed
input selection and library organization. Do not create another storage, GPU queue,
research engine or redo completed context/research functionality.

The running user app, artwork, credentials, model assets and Tailscale configuration
were not modified or restarted. No release, master merge or new branch was created.
The native held-plan test does not contact a researcher or download a model. Provider
quality, real user manuscripts and ChatGPT/Tailscale acceptance remain separate,
deferred tests rather than claims derived from synthetic provider responses.
