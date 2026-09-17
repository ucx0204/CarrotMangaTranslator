# MCP context editing and research checkpoint

Status: implementation in progress, based on c85a660a. Do not advertise these tools as available until the integration and acceptance checks below pass.

## Scope

One existing work selected by chapter ID. Explicit glossary/character additions, partial updates and disabling; translation-rule edits; explicit page-memory edits. Do not rewrite existing page translations or run OCR, image processing or typography. No whole-library automation, destructive reset or reference-merging operation in this increment.

Both user-directed edits and research changes use preview -> inspect -> explicit selection -> atomic application. Reuse the app's schemas, context files, activity ownership, library transactions and research engine. Preserve unrelated context entries, chapters, blocks and files. Missing context files must have stable read revisions, without being created by reads.

## Planned checkpoints

1. Bounded edit contracts, stable context revisions and pure partial-edit policy; tests for duplicates, invalid references, empty/no-op and preservation.
2. Atomic library-facade commit for guide and memory, version/ownership/authorization rechecks and rollback tests. Expose reviewable session-local proposals and idempotent apply receipts.
3. Existing app research engine as a managed, cancellable job. Separate proposal generation from application; support externally supplied evidence without claiming server verification. Research does not write page memories.
4. Tool registration, output contracts, permission and HTTP tests; focused and complete repository checks.
5. Isolated native acceptance, live connector availability check and exact handoff of any unverified provider behavior.

## Invariants

- No parallel local model workloads; retain the app's shared model lease through cleanup.
- Metadata editing uses the existing work-context activity resource. Page-dependent memory changes must recheck page revisions at commit.
- No unconditional whole-guide overwrite, no arbitrary filesystem paths, no credentials in results, no automatic file attachments.
- Expired/foreign/stale proposals fail without mutation. Retry of an already applied request never applies again after later edits.
- App and external research provenance are distinct. Evidence is reference data, not tool instructions. Sources do not become page-read memory automatically.
- Use feat/mcp-app-bridge only, with small commits and remote checkpoints.

No user library or app configuration was changed when this checkpoint was written.
