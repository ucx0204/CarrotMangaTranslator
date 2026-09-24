# Context/research dependency review — 2026-09-17

This bundle extends the existing MCP composition, not a second library, lock manager, model queue, or research engine. The new editing facade reads the latest snapshot inside `withLibraryMutation`, checks the work-context activity, and publishes style-guide and memory files through one existing `runLibraryTransaction`. Authorization is checked again before publication.

## Direct dependency decisions

The integration checkpoint recorded these exact source-only measurements. They must be rechecked by the full architecture gate; these are file-specific ceilings, not general exemptions.

| Owning file                               | Ceiling                  | Reason                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/appActivityTypes.ts`          | 28 consumers             | Context edit and research scopes declare existing work-context/content activities. They must share the app/UI lock vocabulary.                                                                |
| `src/shared/pageRevision.ts`              | 45 consumers             | Context edit policy validates the current page revision before updating page memory. No new fingerprint algorithm.                                                                            |
| `src/main/application/mcpEditPolicy.ts`   | 38 consumers             | Context policy, proposals, research and adapters reuse the existing typed error contract rather than copying errors or wrapping imports to hide dependencies.                                 |
| `src/main/library.ts`                     | 13 imports; 38 consumers | The public facade exposes exactly the context-edit read/commit operations. Context composition remains outside libraryStore; atomic publication remains inside the existing repository queue. |
| `src/main/mcp/mcpPageOperationSession.ts` | 18 imports               | The existing session composes context tools alongside page, OCR, translation and recovery tools, including stop/close. It does not create another operation manager.                          |

`src/main/library.ts` may explicitly re-export from `./library/libraryContextEditingFacade`. No wildcard, new umbrella barrel, or additional re-export source is approved by this decision.

## Behavior that must remain covered

- Preview performs no context/page/image writes.
- Selected glossary, character, rules and memory patches preserve all unspecified fields and original page/image data.
- Context/page revisions and authorization are rechecked under the existing activity and transaction boundaries.
- Partial application cannot silently expand to unreviewed changes.
- Research execution releases its activity before publishing a queued proposal, avoiding the reproduced research/apply deadlock.
- Persistent receipts distinguish research targets from page targets and never persist session-only proposal bodies.

The global import ceilings, historical coverage floors, parser behavior, storage guards and existing algorithms remain unchanged. See `mcp-context-research-verification-20260917.md` for the earlier measurements; a successful final gate must be recorded separately after it actually completes.
