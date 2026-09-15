# MCP adversarial acceptance checkpoint — 2026-09-16

Branch: `feat/mcp-app-bridge` only. Worktree: `CarrotMangaTranslator-MCP-Review`.
No release, master push, new branch, credential reset or user-library cleanup.

## Published fixes and regression harness

- `5af5c415ea7a111a2d9f625edea1be089c80b4d0`: reject deferred synchronous writes after the requesting client disconnects; guard again at the write boundary.
- `06c2426c24c05bb346a0e12d25132b0c1c9f7f52`: bind chapter review/export inspection to chapter ownership and page ordering, not just individual page revisions.
- `f4f69fbeb903485c4ea7fb0487e272b596751063`: run hostile requests against the real production tool set through an isolated OAuth/HTTP server in native Electron.
- All three commits were verified on the remote branch. The final native harness is source, not an unapplied patch.

## Completed local verification

- The repository check runner completed all **26 gates** with exit code 0.
- Its Vitest report records **7,133 passed, 0 failed, 11 existing pending tests**.
- Includes renderer/main/JavaScript types, lint, format, test mock boundaries, architecture, coverage floors, Windows build, image protocol and renderer/preload boundaries.
- Native Electron smoke exited 0 and printed `PASS MCP native smoke finished`.
- Hostile HTTP matrix: **155 checks across 22 production tools**.
- Invalid root types/unknown fields/prototype-shaped input, insufficient scope, missing/duplicate block IDs, invalid reading orders, invalid styles, oversized text and out-of-bounds block creation were rejected.
- A Korean/Japanese/emoji/newline/HTML-shaped string roundtripped through HTTP and real block storage, then was explicitly restored.
- Native checks also exercised selected erasure, original-region preservation, source crops, saved context, actual lettering render, review/export-preflight parity, original-resolution PNG and revoked output access.
- The native image inference boundary is deterministic test code; it is not evidence of real model quality.

## Live connection versus isolated acceptance

The conversation previously read the `MCP Edge Audit 20260916` synthetic work, its pages and blocks through the installed connector, and submitted a 480x640 PNG export. The final `carrot_get_job` call in this conversation was denied with `FORBIDDEN: This conversation does not support developer MCPs`. Do not infer its final result from that failed call or bypass the restriction with copied live credentials. Direct calls to newer tools not exposed by this conversation are not claimed here; the 22-tool matrix above is isolated native HTTP acceptance.

The separate live model exercises from the preceding audit and native deterministic smoke are different evidence. The successful Unicode roundtrip proves the app HTTP/storage path; it does not by itself diagnose every earlier client-side Unicode timeout.

## Logs and isolation

Existing verification files are under `.tmp/mcp-adversarial-20260916/`:
`final-check.log`, `final-check.exit`, `native-hostile-final.log`, `native-hostile-final.exit`, and the earlier before/after defect reproductions.
The machine-readable test report is `.tmp/check-results/vitest.json`.
The pre-existing user backup manifest contains 17 entries; neither it nor user data/authentication files were modified in this finalization.

An earlier native run failed at startup because the live app occupied port 38475. The final run used the existing `CARROT_MCP_SMOKE_PORT=38476` test option; it did not stop the user app or change production port policy. The isolated listener was confirmed closed afterward; the original app remained on 38475.
A Windows directory-fsync best-effort warning is still logged; both final exit codes and required success markers were checked rather than treating stderr alone as failure.

Re-run on a free test port with `CARROT_MCP_SMOKE_PORT` set only for that process, then execute `node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs`. Never point this synthetic fixture at a user data root or enable its optional public tunnel unintentionally.
