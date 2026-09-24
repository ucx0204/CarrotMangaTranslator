# MCP context editing and research checkpoint

Status: the single-work implementation, Windows CI acceptance and live context/Tavily acceptance are complete. See `mcp-context-research-closeout-20260917.md` for the current evidence and exact limitations. Source commit `af8c5863` passed all 26 repository gates; the live test used one actual Tavily research job and all five context/research tools. Earlier checkpoints below are retained as implementation scope, not pending work.

Remote Desktop Commander was offline during final live acceptance. A fresh local Git synchronization, disk-hash audit and local model-process check were not performed. Existing fixture fields were restored, but one explicitly disabled research-test glossary addition and normal context audit metadata remain. No general user work was selected for mutation.

## Scope

One existing work selected by chapter ID. Explicit glossary/character additions, partial updates and disabling; translation-rule edits; explicit page-memory edits. Do not rewrite existing page translations or run OCR, image processing or typography. No whole-library automation, destructive reset or reference-merging operation in this increment.

Both user-directed edits and research changes use preview -> inspect -> explicit selection -> atomic application. Reuse the app's schemas, context files, activity ownership, library transactions and research engine. Preserve unrelated context entries, chapters, blocks and files. Missing context files must have stable read revisions, without being created by reads.

## Completed implementation checkpoints

1. Bounded edit contracts, stable context revisions and pure partial-edit policy; tests for duplicates, invalid references, empty/no-op and preservation.
2. Atomic library-facade commit for guide and memory, version/ownership/authorization rechecks and rollback tests. Reviewable session-local proposals and idempotent apply receipts.
3. Existing app research engine as a managed, cancellable job. Separate proposal generation from application; support externally supplied evidence without claiming server verification. Research does not write page memories.
4. Tool registration, output contracts, permission and HTTP tests; focused and complete repository checks.
5. Isolated native acceptance and live Tavily/context tool acceptance. Unverified provider and local-machine behavior is explicitly recorded in the closeout.

## Invariants

- No parallel local model workloads; retain the app's shared model lease through cleanup.
- Metadata editing uses the existing work-context activity resource. Page-dependent memory changes must recheck page revisions at commit.
- No unconditional whole-guide overwrite, no arbitrary filesystem paths, no credentials in results, no automatic file attachments.
- Expired/foreign/stale proposals fail without mutation. Retry of an already applied request never applies again after later edits.
- App and external research provenance are distinct. Evidence is reference data, not tool instructions. Sources do not become page-read memory automatically.
- Use feat/mcp-app-bridge only, with small commits and remote checkpoints.

For operation names, limits and usage, see `mcp-context-research-testing.md`. For the prior failed/interrupted verification evidence, see `mcp-context-research-verification-20260917.md`. Its pending items are superseded by the current closeout, not silently reclassified as successful runs of the original failed commands.
