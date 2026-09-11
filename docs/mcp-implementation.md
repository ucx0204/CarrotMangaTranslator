# Carrot MCP implementation handoff

Branch: `feat/mcp-app-bridge`. Do not merge or release automatically.

## Product contract

Expose the existing application, not a second manga translator. The desktop UI and MCP must share application services, the library facade, revision checks, redaction policy, renderers and runtime resource ownership. Do not publish raw IPC, shell execution, arbitrary filesystem paths, credentials or unredacted originals.

Support application-engine, external-agent and mixed execution as separate, explicit policies. External-agent reading/translation must not silently launch OCR or a paid model. Image generation and client-side sampling are optional capabilities, not assumptions about the connected chat model.

## Ordered milestones

- [ ] 1a. Inventory existing service boundaries and expose an opt-in, authenticated, read-only MCP endpoint inside the existing app.
- [ ] 1b. Validate input, sanitize library output, enforce Host/Origin restrictions, bound requests and add behavioral tests.
- [ ] 1c. Add Cloudflare Quick Tunnel lifecycle, safe preview delivery and client setup instructions. Verify actual clients; never advertise untested OAuth/UI compatibility.
- [ ] 2. Share existing import/translation/inpainting/export application services with MCP, with managed jobs and cancellation.
- [ ] 3. External AI reading/translation submission, page-revision checks, explicit coordinate contracts and no-OCR execution.
- [ ] 4. Region/mask operations, sound effects, image lettering, batch edits and review.
- [ ] 5. Multi-chapter import and work-context research/replace with provenance, stable references and rollback.
- [ ] 6. Optional MCP Apps viewer, artifact downloads, OAuth and client-specific acceptance tests.

Milestones can be split into small commits. Push each coherent checkpoint; leave this file accurate about what is implemented, tested, or still blocked. The order above does not make unauthenticated remote access acceptable as an intermediate state.

## Reuse inventory

| Capability                | Existing boundary                                            | MCP work                                                          |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Library read/write        | `src/main/library.ts` and its feature facades                | Explicit DTOs; no storage bypass                                  |
| Web import                | `src/main/application/webImportService.ts`                   | Reuse sessions, progress, cancellation and cleanup                |
| Translation               | `src/main/wholePagePipeline.ts`, `src/main/jobs`             | Extract only necessary orchestration after characterization tests |
| Image editing             | `src/main/codexImageEditing.ts`                              | Feed translated blocks into existing erasure/lettering/rendering  |
| Text geometry and styling | `src/shared/textTypes.ts`                                    | Preserve source/render geometry and generated lettering           |
| Work context              | `src/main/library/libraryContextFacade.ts`                   | Preserve glossary/speaker references and transactions             |
| Jobs                      | `src/shared/jobTypes.ts`, `src/main/appOperationRegistry.ts` | Reuse ownership; add resumable external-input jobs later          |

## Security and compatibility acceptance

The server must be disabled by default, bind loopback only, reject missing/invalid credentials, enforce an explicit public origin rather than trusting forwarded headers, and stop accepting work on shutdown. Quick Tunnel transport must not require SSE. Private library data must not appear in errors or logs. No original-image endpoint is allowed until existing image-redaction policy is applied and tested.

Do not assume ChatGPT accepts a static bearer token configuration. OAuth and real client tests are required before claiming ChatGPT web support. CLI clients with explicit Authorization headers can be validated separately. A hosted chat model cannot keep working after it disconnects; external-input jobs must pause and resume explicitly.

## Validation record

Initial repository inspection completed through the connected GitHub tools. The execution container has Node 22 but cannot resolve github.com, so direct clone is unavailable. GitHub API commits are the remote checkpoints. Record local focused tests separately from full-repository checks and real Electron/client/tunnel tests; do not claim tests that have not run.

## Next action

Read the current composition root and library contracts, implement the smallest read-only service and transport boundary, and commit behavioral tests with the implementation. No production runtime, protected OCR/font algorithm, app release, or user library data has been changed.
