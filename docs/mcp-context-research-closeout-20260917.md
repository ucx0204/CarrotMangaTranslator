# Context editing and research closeout — 2026-09-17

## Current status

The single-work context editing and research increment is implemented, registered and verified through the live Carrot connection. This report supersedes the pending integration/provider statements in `mcp-context-research-checkpoint-20260917.md` and `mcp-context-research-verification-20260917.md`; those records describe earlier attempts.

The validated source commit is `af8c586386ade6815f4ffaf540ebf979267d8dd9` on `feat/mcp-app-bridge`. This closeout changes documentation only. A new documentation-triggered CI run is not claimed to have completed merely because the source run passed.

## Available workflow

- `carrot_get_work_context`: read the saved sections and current context revision.
- `carrot_preview_context_edit`: propose explicit glossary/character additions, partial edits or disabling, rule edits, and page-memory edits.
- `carrot_preview_context_research`: submit externally supplied glossary/character changes and evidence. The server does not fetch or independently verify submitted URLs.
- `carrot_run_context_research`: run the existing app's selected Tavily or Codex-web research for one work, returning a job receipt. Poll `carrot_get_job` until it actually finishes.
- `carrot_get_context_proposal`: inspect paginated before/after fields and research evidence.
- `carrot_apply_context_proposal`: apply only explicitly selected changes through the existing atomic context transaction, with current authorization and context/page-memory checks.

Preview and research do not apply results automatically. Application does not rewrite existing page translations, blocks, images or masks. Omitted fields and unrelated entries are preserved. Disabling an entry does not delete references to it. Research cannot directly author page-read memory.

Proposals are session-local and expire after 30 minutes or server restart. An application consumes its proposal, including when only some changes are selected; unselected changes require a fresh preview. Exact application retries return historical receipts rather than applying again after later edits. Receipt revisions and counts describe that original application, not the current context or a second write.

## Completed Windows CI

GitHub Actions run `35211249301`, job `105169013171`, completed successfully on the exact source commit above. The complete job log and final job conclusion were both inspected.

- Focused MCP/existing-library suite: 619 passing tests across 82 files.
- App build, static checks, and production MCP settings layout assertions passed.
- Native Electron smoke finished successfully, including 235 hostile checks across 34 production tools.
- Native context checks covered glossary/character/rules/memory preview and atomic application, exact retries, selected external research application, preserved optional fields/provenance, stale proposal rejection and unchanged page data.
- Full `npm run check`: all 26 gates passed, with final `[check] passed in 870.08s` at 2026-09-17 10:58:47 UTC. Coverage, production cleanup coverage, build, artwork parity, image protocol and both bundle gates passed.
- Acceptance artifact: `mcp-full-acceptance`, ID `10493172088`, ZIP SHA-256 `a6fc5f17547426b3bc45ef10b654f8b5bd7d52424985be647b6cdc9073d00385`.

The 619 figure is the focused suite, not an invented aggregate for the full coverage run. Heavy inference and research responses in isolated native tests are fixtures. Real Tavily acceptance is recorded separately below. Existing package-audit warnings were not remedied by this increment; passing these gates is not a claim that all dependencies are vulnerability-free.

## Real Tavily acceptance

Only the pre-existing disposable work was used:

- Work: `MCP Edge Audit 20260916`, ID `34a026df-b18e-48bc-9996-b22cc471150b`.
- Chapter: `Disposable synthetic pages`, ID `d288a495-0d67-49eb-88a8-62d246ebf897`.
- Starting context revision: `91281d2adf309284`.
- Explicit research title: `銀河鉄道の夜（宮沢賢治）`.
- Request ID: `996725d0-1fdc-41ca-b2b1-40f1b0707348`.
- Completed job ID: `fa35d2c7-b7c9-4e35-b4f4-f448d5d79155`.
- Research proposal ID: `b520f14c-c957-4876-a248-3bb57b0963f0`.

The app reported a completed `proposed` result, `pagesChanged: 0`, 20 searches, 4 sources and 20 Tavily credits. The key itself was never read, printed or changed. No additional full research run was requested after this successful one.

The result contained one new glossary proposal and one new character proposal. Reading context after research confirmed the original revision and counts: no automatic application. Selecting only `research-1` saved the glossary entry; the unselected character was not added and the memory count did not change. An exact repeat returned `already_applied` without adding another entry.

These are execution and selection results, not independent confirmation of the research's factual completeness. In particular, an engine-generated reason claiming official or local corroboration must still be reviewed; the disposable chapter is not evidence about the researched story. Research evidence was not inserted into page-read memory.

## Live edit and external-evidence roundtrips

Four existing fixture fields were previewed, inspected in two proposal pages, explicitly applied and read back:

1. A disabled glossary entry's target text.
2. A disabled character's speech style (`polite` to `casual`).
3. The honorific rule (`adapt` to `preserve`).
4. The existing OCR page's memory summary, retaining its glossary/character reference IDs.

A fresh four-field preview restored all four original values. The research-added glossary row was separately disabled and labeled as a test record.

The external-evidence tool was also called live. Proposal `79b70f8c-9a9d-49df-804d-9e5d2820daf2` changed only that disabled test row's note, retained its existing origin and disabled state, and returned the explicit warning that caller-supplied sources were not fetched or verified. The note was applied, read back, then restored through another reviewed proposal. Its source URL came from the earlier Tavily response and was explicitly labeled as not independently reverified; the test did not assert new story facts.

Negative/retry checks performed on the live connection:

- A preview created before another context change failed with `revision_conflict`.
- Selecting an ID absent from the proposal failed with `invalid_edit`.
- A page-memory edit referencing a nonexistent character failed with `invalid_edit`.
- Exact research-application retries returned the original receipt.
- Replaying that original application after the new row had been disabled and later notes restored did not re-enable it or change the current revision.

All successful applications reported `pagesChanged: 0`. There were no image attachments or file-return calls.

## Final saved state and preservation limits

Final context revision after the external note restoration: `d74c2e012ac37052`. Existing fixture glossary text, character speech style, rules and memory content were restored. Reference IDs and omitted fields were preserved in readback.

The test intentionally leaves ONE additional disabled glossary row:

- ID: `6f513a01-eb7a-4bf4-a248-d05e0bbe060a`.
- Source/target: `プリオシン海岸` / `프리오신 해안`.
- `enabled: false`, `origin: ai`.
- Note labels it as a Tavily selective-application test record, not an actual term for the disposable work.

Final counts are two glossary entries, one character and one memory. The new research character was never applied. This is not a byte-identical rollback of the whole context store: the disabled addition, normal edit timestamps, completed job and temporary proposal/receipt records remain.

The `ocr.png` page (`ca7ca5ab-e086-405a-90f6-451c996e7197`) retained revision `page-v1:da911a4536b17c2f`. Both original source strings, empty translations, source/display rectangles, scalar typography, block IDs and reading order matched the baseline tool response. Final chapter/page metadata, including their modification times, also matched the baseline. No page-edit, translation, OCR, erasure, image-export or image-return tool was invoked in this acceptance session.

Remote Desktop Commander reported `4090desktop` offline and its ping failed. Therefore this session did not inspect local file hashes, model process/VRAM termination, the local Git working tree or local/remote synchronization. These live preservation checks are MCP readback checks, supplemented by the isolated CI byte-preservation tests; they are not a claimed fresh disk-level audit of the user's machine. The normal app and authentication/provider settings were not restarted or changed.

## Remaining scope, not blockers for this increment

Whole-library automation, destructive replacement, hard deletion/merging with reference migration, persistent context undo, external-source fact verification, exhaustive provider/language quality tests and new UI/UX are separate work. Codex-web was not exercised against the user's live account here. The existing app's configured search/model budgets and fallback behavior still apply; this test does not promise one search or one model call per research job.
