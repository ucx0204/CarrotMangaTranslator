# Carrot MCP implementation handoff

Branch: `feat/mcp-app-bridge`. Draft PR #96. Do not merge or release automatically.

User-facing setup, diagnostics, Codex configuration, optional manual tunnel and troubleshooting: [MCP 직접 테스트 안내](mcp-testing.md).

## Product contract

Expose the existing application, not a second manga translator. The desktop UI and MCP must share application services, the library facade, revision checks, redaction policy, renderers and runtime resource ownership. Do not publish raw IPC, shell execution, arbitrary filesystem paths or credentials. Image transfer is separately enabled by the local user and must never bypass image-redaction approval.

Support application-engine, external-agent and mixed execution as separate, explicit policies. External-agent reading/translation must not silently launch OCR or a paid model. Image generation and client-side sampling are optional capabilities, not assumptions about the connected chat model.

## Ordered milestones

- [x] 1a. Inventory existing service boundaries and implement an opt-in, authenticated, read-only MCP endpoint inside the existing app.
- [x] 1b. Validate input, sanitize library output, enforce Host/Origin restrictions, bound requests and add behavioral tests.
- [x] 1c-preview. Wire optional reduced PNG previews through the existing external-image redaction guard. Fail closed when local review is required.
- [x] 1c-setup. Provide a local launcher, credential reuse, real HTTP diagnostic command and Korean client/tunnel setup guide.
- [ ] 1c-acceptance. Complete supported-platform app/build acceptance, real client and live tunnel tests. Add managed Quick Tunnel lifecycle and local redaction-review approval interaction.
- [ ] 2. Share existing import/translation/inpainting/export application services with MCP, with managed jobs and cancellation.
- [ ] 3. External AI reading/translation submission, page-revision checks, explicit coordinate contracts and no-OCR execution.
- [ ] 4. Region/mask operations, sound effects, image lettering, batch edits and review.
- [ ] 5. Multi-chapter import and work-context research/replace with provenance, stable references and rollback.
- [ ] 6. Optional MCP Apps viewer, artifact downloads, OAuth and client-specific acceptance tests.

Checkboxes distinguish implementation from end-to-end acceptance. Milestone 1 as a whole is not complete until its acceptance items pass. Push coherent checkpoints frequently, without force-pushing over concurrent work.

## Implemented entrypoints

`node scripts/mcp-dev.cjs` starts the existing development app with four read-only tools. `--images` adds `carrot_get_page_preview`. The local token is reused from `.tmp/mcp-local-token` unless an explicit environment token is supplied; secrets are not printed. This uses the existing development build, instance lock and child-process cleanup rather than a second app process model.

`node scripts/mcp-smoke.mjs` checks invalid-token rejection, initialization, notifications, tool discovery and actual library metadata. `--first-preview` additionally saves a bounded PNG response to a unique `.tmp` file. It does not invoke OCR, a model, or a library write. Tests execute this exact script against the real HTTP server.

`node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs` runs the real compiled runtime with a synthetic page imported through the existing library facade into an exclusively created temporary data root. It checks actual PNG processing, redaction-enabled refusal and listener shutdown. The native smoke is not a full desktop UI, remote model or tunnel acceptance test.

## Reuse inventory

| Capability | Existing boundary | MCP work |
| --- | --- | --- |
| Library read/write | `src/main/library.ts` and its feature facades | Read projections implemented; writes pending; no storage bypass |
| Image previews | `imageRedactionContext.ts`, `inpainting/imageIO.ts` | Existing external-image guard and native image decode/resize |
| Web import | `src/main/application/webImportService.ts` | Reuse sessions, progress, cancellation and cleanup in later phase |
| Translation | `src/main/wholePagePipeline.ts`, `src/main/jobs` | Extract only necessary orchestration after characterization tests |
| Image editing | `src/main/codexImageEditing.ts` | Later feed translated blocks into existing erasure/lettering/rendering |
| Text geometry and styling | `src/shared/textTypes.ts` | Preserve source/render geometry and generated lettering |
| Work context | `src/main/library/libraryContextFacade.ts` | Preserve glossary/speaker references and transactions |
| Jobs | `src/shared/jobTypes.ts`, `src/main/appOperationRegistry.ts` | Reuse ownership; add resumable external-input jobs later |

The app composition adds one dependency on `mcpRuntime`; that runtime adds one consumer of the existing library facade. Only these two composition budgets are explicitly documented. General dependency and complexity ceilings are unchanged; do not introduce alias wrappers to hide the dependencies.

## Security and compatibility acceptance

The server is disabled by default, binds loopback, rejects missing/invalid credentials and validates an explicit public origin rather than trusting forwarded headers. It uses the tools-only JSON response profile of Streamable HTTP; no SSE connection, server session or server-to-client sampling is required.

Only opaque work/chapter/page identifiers are accepted. Remote errors do not return local paths, original error messages or secret settings. Image transfer is off by default, limited to a 1600-pixel long edge and 4 MiB PNG, and subject to the existing external-image guard. When the app requires manual redaction review, the current MCP preview cannot establish that approval and must fail without returning image bytes. Do not treat saved masks as automatic approval or disable protection for private pages.

Cloudflare tunnel startup is currently manual, not app-managed. HTTPS origin and bearer credentials are configured explicitly. Do not assume ChatGPT accepts a static bearer token configuration: OAuth and real client tests are required before claiming ChatGPT web support. Codex settings in the guide follow the official MCP configuration contract, but a real logged-in model session must be tested separately. A hosted chat model cannot keep working after it disconnects; future external-input jobs must pause and resume explicitly.

## Validation record

The execution container cannot resolve GitHub/npm. Code is committed through the connected GitHub API. Actual dependency installation and checks run in Actions, not through a substituted local test runner.

Checkpoint run `34599953679` (formatted code commit `8fb562a5ea1f842e26f2ade03211db90baebfce8`) passed all 58 focused Vitest tests across four files, launcher/diagnostic help entrypoints, all three typechecks, formatting, dependency rules/budgets, error-handling policy, ESLint, unused exports, script entrypoints, maintainability and duplicate checks. Its `npm run build` compiled the code and renderer but failed at existing native ONNX staging because Linux packaging is unsupported. The native smoke did not run in that job. Validate full build and native smoke on a supported Windows/macOS runner rather than weakening the packaging guard.

Later exact run/commit results belong in PR #96. Do not infer full `npm run check`, real app UI, live Cloudflare, Codex/Claude/ChatGPT model sessions, OAuth or translation acceptance from the focused suite. No protected OCR/font algorithms, dependencies, releases or existing user data have been changed.

## Next action

Finish supported-platform build/native smoke, then exercise the guide on a separate development clone with a public test image. Resolve genuine acceptance failures before exposing writes. Next feature work should be the local approval/tunnel experience and shared managed-job services, not an unrelated translator implementation.
