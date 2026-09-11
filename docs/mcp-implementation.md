# Carrot MCP implementation handoff

Branch: `feat/mcp-app-bridge`. Draft PR #96. Do not merge or release automatically.

Local test guide: [MCP 직접 테스트](mcp-testing.md). Current priority: [ChatGPT 웹 연결](mcp-web-testing.md). The user confirmed the local baseline works and requested web testing because their Codex quota is exhausted. Do not require Codex to test this connection.

## Product contract

Expose the existing application, not a second translator. Desktop UI and MCP must share application services, the library facade, revision checks, redaction policy, renderer and resource ownership. No raw IPC, arbitrary file paths, shell execution or credentials are exposed as tools. External-agent reading must not silently launch local OCR or a paid model.

## Milestones

- [x] Local opt-in authenticated read-only endpoint, safe library projections and bounded HTTP requests.
- [x] Optional 1600-pixel / 4 MiB PNG source previews through the existing external-image guard.
- [x] Local launcher, HTTP diagnostic, supported Windows build/native smoke and user-confirmed local test.
- [x] Implement personal OAuth discovery, DCR, browser consent, PKCE, resource-bound access and rotating refresh tokens. Implementation is distinct from end-to-end acceptance.
- [x] Implement owned Quick Tunnel startup and exact-origin configuration in `mcp-web.cjs`, quota-free OAuth diagnostic and Korean ChatGPT guide.
- [ ] Record the latest passing Windows checkpoint, native OAuth and live synthetic Cloudflare tests in PR #96.
- [ ] Actual user ChatGPT web connection and image/tool acceptance. Do not claim an account session was tested without evidence.
- [ ] Local image-redaction approval interaction. Current previews fail closed when review is required.
- [ ] Shared read/write editing context, revision-checked block patches, external-agent readings and editable translation submissions.
- [ ] Managed OCR/translation/erasure/lettering jobs, result rendering and PNG/ZIP export through existing app services.
- [ ] Advanced region/mask/SFX editing, multi-chapter import and research/context replacement with provenance and rollback.
- [ ] Optional MCP Apps viewer and broader client acceptance; no public plugin-directory release has been performed.

## Entrypoints

`node scripts/mcp-dev.cjs [--images]` retains the established local Bearer connection. The token is reused from `.tmp/mcp-local-token` or explicit environment configuration. The existing development build, app locks and child cleanup are reused.

`node scripts/mcp-web.cjs [--images]` requires a locally installed `cloudflared` (optional explicit `CARROT_CLOUDFLARED_PATH`). It owns one Quick Tunnel child, writes its exact public origin into app startup configuration, creates a separate random `.tmp/mcp-web-password`, and prints only the public URL. `.tmp/mcp-web-connection.json` contains public endpoint information, not credentials. READY verifies public OAuth resource metadata, not ChatGPT itself. Normal parent exit closes its tunnel; unexpected tunnel exit initiates app shutdown. No system tunnel service or downloaded binary is installed by the user launcher.

`node scripts/mcp-smoke.mjs [--first-preview]` performs the original local diagnostic. `node scripts/mcp-web-smoke.mjs` tests public discovery, DCR, consent, PKCE, token rotation, authenticated MCP/library reads and revocation. It never follows the ChatGPT callback, prints tokens, calls an AI, or modifies the library.

`node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs` imports a synthetic PNG through the actual library facade into a new temporary data root and exercises the compiled native app, OAuth, previews, redaction refusal and shutdown. `CARROT_MCP_SMOKE_TUNNEL=1` explicitly adds a real Quick Tunnel for this synthetic-only test. Existing user libraries/settings are not copied. The CI binary is pinned to Cloudflare 2026.9.1 Windows amd64 with size/SHA-256 verification; no runtime package upgrade or bundled dependency was added to the product.

## Web security boundary

The server binds loopback and requires exact allowed Host/Origin values, never arbitrary forwarded headers. Only discovery/consent/client-registration routes are public; MCP tool calls still require static Bearer or scoped OAuth access. No unauthenticated library access is introduced. The web connection grants read access to the whole running test library; images remain separately opt-in and subject to the existing guard.

This is an ephemeral personal development authorization server, not OIDC, a multi-user identity provider or a production security certification. DCR is restricted to documented ChatGPT callback shapes, then each client's exact URI is enforced. Arbitrary metadata/client/logo URLs are never fetched. The browser must present a secure consent cookie, same-origin POST, one-use transaction and separate local connection password. Only S256 is accepted. Access grants are bound to this exact MCP resource. Codes expire after 60 seconds, access after at most one hour, grants after 24 hours; refresh replay revokes the family. All OAuth state is bounded and in memory. Restart revokes existing OAuth sessions. DCR records/temporary grants consume bounded capacity; restart the personal test instance after excessive registrations.

Only `carrot.read` (and optional offline_access) is supported. No OAuth writes, implicit flow, password grant, arbitrary callback, token URL query, sampling or CIMD capability is advertised. The local connection password is not an OpenAI credential or OAuth client secret. Never put it into the chat or repository. New Quick Tunnel URL means update/recreate the ChatGPT connection and reauthorize.

## Reuse boundaries

| Function         | Existing app authority                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| Library          | `src/main/library.ts`, existing read/mutation locks and notifications        |
| Preview          | `imageRedactionContext.ts`, `inpainting/imageIO.ts`                          |
| Translation      | `wholePagePipeline.ts`, `jobs/translationJobs.ts` and existing job contracts |
| Export           | `application/pageImageExportService.ts` and actual app renderer              |
| Web import       | `application/webImportService.ts`                                            |
| Work context     | `library/libraryContextFacade.ts`                                            |
| Blocks/revisions | `shared/textTypes.ts`, `shared/shareTypes.ts`, `shared/pageRevision.ts`      |

Only the original main composition/library-consumer budgets were adjusted in the local baseline. General complexity/dependency limits remain enforced; no alias wrappers or lint-rule disabling to conceal new coupling. No protected OCR/font algorithms, releases or user data are changed.

## Validation and next recovery action

Historical local baseline `690f85885c76146d2d6663e7a9d27095424d5f58`, Windows run `34601170665`, passed 58 actual Vitest tests, build, native synthetic preview/redaction/shutdown and broad static gates. The user subsequently confirmed local operation.

The first web checkpoint run `34611091342` reached 90/91 tests passed; its one failing Host test used fetch, which did not send the intended hostile Host header. The regression now uses node:http. That run also identified a long HTTP factory, a missing retry-policy annotation and a missing AggregateError cause; these were corrected in subsequent commits without relaxing the gates. New successful results must be recorded from the exact later run, not inferred from this record.

The editing container cannot resolve GitHub/npm; dependency installation and full checks execute in Actions. Inspect the latest `MCP checkpoint` on this branch, correct actual failures, verify native plus live HTTPS stages and update PR #96. Preserve a distinction between scripted OAuth tests and the user's real ChatGPT authorization flow. Do not mark full `npm run check`, all PR workflows, actual ChatGPT/Claude model sessions or plugin UI acceptance complete from a focused test alone.
