# MCP remaining implementation sequence — 2026-09-18

Continue only on `feat/mcp-app-bridge` in the existing review worktree.
Starting verified checkpoint: `fbfe656c`. Preserve existing user changes first.
User instruction: implement bundles 1–13 in order, commit/push small units, and
leave an exact resume point when interrupted. Live tests are deferred until ALL
bundles are implemented; do not ask for a live test between development units.
Automatic unit/integration, type, lint, architecture, coverage and build checks
remain enabled. Do not restart the live app, modify user artwork/credentials,
replace approved model assets, merge master or publish a release implicitly.

| Order | Remaining bundle                                                                     | Status      |
| ----- | ------------------------------------------------------------------------------------ | ----------- |
| 1     | C23 independent analysis; selective font/source-size application and exact undo/redo | In progress |
| 2     | Bubble layout, advanced typography, reusable rules/presets                           | Not started |
| 3     | Remaining region/multi-block OCR, translation and block references                   | Not started |
| 4     | Multi-block erasure, free/protected masks, localized correction/restoration          | Not started |
| 5     | External image/mask upload, validation and layer incorporation                       | Not started |
| 6     | Independent sound-effect preparation, text, generation and recovery                  | Not started |
| 7     | Durable undo and retained output assets                                              | Not started |
| 8     | Model-grouped sequential jobs, chapter batches and explicit resume                   | Not started |
| 9     | Context merge/replacement, reference migration and multi-work research               | Not started |
| 10    | File/web import and library organization                                             | Not started |
| 11    | Extra export/exchange formats and attachment/delivery diagnostics                    | Not started |
| 12    | Composite workflows and bounded automated review                                     | Not started |
| 13    | Client compatibility, diagnostics, installation and UI/UX                            | Not started |

Live C23 quality, model cleanup, actual originals, PNG/ZIP attachment reception,
download byte/hash checks, restart/reconnection and end-to-end client acceptance
belong to the final integrated live-test queue, not intermediate completion claims.
