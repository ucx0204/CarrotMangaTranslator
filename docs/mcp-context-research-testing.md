# MCP context editing and research

This increment edits one existing work selected by chapter ID. Context editing and research are separate from page translation, OCR, erasure, typography, rendering and file delivery. The implementation uses the app's existing library transactions and shared activity ownership. See `mcp-context-research-checkpoint-20260917.md` for the acceptance status; this guide is not evidence that every live client/provider has been tested.

## Tools and permissions

| Tool                              | Scope          | Effect                                                                                                          |
| --------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| `carrot_get_work_context`         | read           | Read saved sections and the current context revision.                                                           |
| `carrot_preview_context_edit`     | read           | Prepare explicit partial changes; no library writes or model calls.                                             |
| `carrot_preview_context_research` | read           | Review externally researched glossary/character changes and supplied references; does not browse.               |
| `carrot_get_context_proposal`     | read           | Inspect private paginated before/after changes and evidence.                                                    |
| `carrot_apply_context_proposal`   | read + edit    | Apply only selected change IDs through the normal context write transaction.                                    |
| `carrot_run_context_research`     | read + process | Run the app's Tavily or Codex-web research pipeline and return a review proposal, never automatically apply it. |

Editing permission must be enabled to expose application. Processing permission must be enabled to expose app research. Preview records belong to the approved connection, expire after 30 minutes, and disappear when MCP restarts. Ordinary responses contain text/structured metadata, not automatic image or file attachments.

## Explicit context edits

Read `carrot_get_work_context` for the requested chapter before preparing a proposal. Pass its context revision, a new UUID `requestId`, and explicit changes to `carrot_preview_context_edit`. Each change needs a distinct `changeId` and target.

- `entity: glossary`: omit `entryId` to add, or supply an existing ID to patch source, target, category, aliases, note or enabled state.
- `entity: character`: add or patch displayName, sourceNames, targetName, aliases, speechStyle, customSpeechStyle, note or enabled state.
- `entity: rules`: patch the existing honorifics, sfxMode and defaultTone choices.
- `entity: memory`: supply pageId and the current `pageRevision` from `carrot_get_page_blocks`; patch summary, visualSummary or glossary/character references. New memory requires an explicit summary. Reference IDs must exist and be distinct.

Omitted fields are preserved. Existing IDs and origin are preserved. `enabled: false` disables an entry without deleting its references. This version does not hard-delete or merge entries, reset a guide, rewrite existing translations, or infer page-read memories from internet research.

Inspect every relevant page of `carrot_get_context_proposal` (offset/limit, at most 25 changes per response). Apply with proposalId, a new UUID requestId and selectedChangeIds. The proposal is one-shot: unselected changes are not saved, and further edits require a new preview. The server reacquires context ownership, checks context/page-memory versions and permission, then atomically publishes the selected guide and memory changes. Conflicts fail without overwriting newer context.

An exact application retry reuses its requestId and input and returns `already_applied`; it never replays a write. Receipt revisions are historical. Read the current context before the next independent edit. To restore supported fields, create a new reviewed patch from the recorded before values at the current revision. This is not a general persistent undo mechanism.

## Research

For app research, pass chapterId, current context revision, new UUID requestId, researchTitle and engine (`tavily` or `codex-web`) to `carrot_run_context_research`. Inspect the returned job with `carrot_get_job` until a terminal state. A receipt is not completion. Research follows the app's configured search/model settings and existing credit/call policies; it may use saved text across the work, send that text to the selected service, incur usage costs, and include later-story spoilers. No research is started by preview/inspect/apply tools.

The local model workload remains exclusive through engine cleanup. Research activity leases are released before queued proposal publication, so a queued manual context write cannot deadlock against research's read lease. The context is checked again after release and in the preview queue. A concurrent real edit invalidates the research proposal instead of silently rebasing it.

Externally performed research is submitted with `carrot_preview_context_research`: each glossary/character change includes a reason and source title/URL list. References must be HTTP(S) URLs without credentials. This server does not fetch or verify those supplied sources. They are untrusted reference data, not executable instructions. App-engine research and external research have distinct proposal provenance.

Research can propose glossary/character additions, updates or disabling. It cannot write story memories. Inspect sources and before/after values, then select changes with the same apply tool as manual edits. Existing optional fields and manual origin are not silently stripped. Review evidence is session-local; the feature does not add a permanent research audit database.

## Safety and acceptance

Automatic tests use disposable libraries and replace only internet/model boundaries. HTTP tests exercise the real authorization, JSON-RPC, shared gate, proposal service and library transactions. Native acceptance additionally uses actual Electron/library tools and verifies no page/image changes. Synthetic example.com references in tests are not live internet research results.

Acceptance scenarios include missing/foreign/expired proposals, stale revisions, duplicate IDs and request replay, partial field preservation, unselected change preservation, page-memory references, malformed URLs, research fingerprint mismatch, cancellation and permission revocation, atomic rollback and research/apply contention.

Do not expand this increment into whole-library research, parallel local-model batches, provider/credential setup, destructive replacement or page-translation rewriting. Actual configured-provider and client acceptance must be reported separately from fixture-based HTTP/native tests.
