# Bundle 9 context-migration coverage evidence

This sub-bundle is whole-work catalog/reference migration and durable recovery.
It does not mark memory freshness/refresh or multi-work research complete.

## Inventory and inherited records

The inherited manifest has 754 baseline records and 928 introduced records (1,682
in total), with ten deletion records. Every inherited row, exact numerator and
denominator, provenance field and deletion record is preserved. Fifteen newly
tracked production modules bring the introduced inventory to 943 and the total
to 1,697. Global architecture, complexity and coverage policies are unchanged.

The actual Windows Vitest/V8 measurement is preserved at
`.tmp/mcp-context-migration-measured-coverage.json`.
SHA-256: `c8de07f805a8bd5d86a91a3312f57d919026abe4b59fb6be27611e5f5163f1a8`.
The corresponding test/timing reports are
`.tmp/mcp-context-migration-measured-vitest.json` and
`.tmp/mcp-context-migration-measured-timings.json`.
That initial complete measurement had one inventory-registration failure, not a
reported successful final gate run. Final verification belongs in the connected
checkpoint after the complete rerun has finished.

New records use actual lines/statements/functions/branches counts from this report,
not guessed percentages. The newly registered modules are:

- application: `mcpContextCatalogMigration`, `mcpContextMigrationPolicy`,
  `mcpContextMigrationPreviewService`, `mcpContextMigrationRecoveryPolicy`,
  `mcpContextReferenceService`;
- native library: `libraryContextMigrationFacade`, `workContextMigration`;
- native MCP: `mcpContextMigrationApplication`, `mcpContextMigrationRepository`,
  `mcpContextMigrationScope`, `mcpContextMigrationSession`, `mcpContextReferenceTools`;
- shared contracts: `mcpContextMigration`, `mcpContextMigrationState`,
  `mcpContextReferences`.

## Behavioral coverage

Existing preview/projection tests cover manual protection, explicit ID mappings,
ambiguous identities, alias behavior, no-op plans, orphan memories, missing targets,
content preservation, scoped pagination and rejection of raw state inputs.

The new native application tests use isolated files and real app composition,
transactions, page ownership, context projections and retention. They cover
multi-chapter changes, restart reconstruction, property/file absence, exact Undo/Redo,
historical replay, wrong owner, later dialogue conflicts, failed notifications,
unchanged intent and absent memory files. Native publication tests revoke authority
and change raw metadata during encryption, and inject failures before and after the
existing transaction commit point. Actual HTTP tests enforce OAuth grant scopes and
revocation through publication.

Retention tests cover owned discard, expiry, all thirty-two real recovery actions
and disabled-editing composition. Only the 32-transaction stress case has a local
60-second test deadline to allow real filesystem/encryption work under the complete
parallel V8 suite; no production timeout or global test deadline is changed.

The inherited `libraryContextEditingFacade` floor initially regressed after adding
whole-work reads. Genuine native inventory-budget, cross-work chapter and invalid
context-transform tests cover the new rejection paths. Its old floors were not
lowered. The native graph reader rejects oversized work/page inventories instead of
truncating them and rejects an otherwise valid chapter resolved from a different
work. Existing page-change/output/workflow retained limits remain 1–50 pages;
context-only records permit 0–1,000 affected pages under existing byte limits.

Vitest substitutes the operating-system encryption boundary with the existing test
codec, not the native transaction or storage policy. The dedicated Electron scenario
uses the real OS encryption path; its success must be established from its explicit
completion marker and process exit, not inferred from this document. No live user
library, provider/model quality, public Tailscale request or chat-file acceptance is
covered by these automatic checks.
