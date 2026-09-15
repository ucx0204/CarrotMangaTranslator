# MCP integration review on the user's Windows desktop

## Latest pairing/defaults checkpoint (2026-09-15)

Exact verified code: `8d6c4cde2a45e4efe53ee5c746ebbf5e3d94e44e`. The current request is all four preferences checked on first use and enrollment available whenever MCP is online, with the existing desktop number-comparison approval retained. Changes are published only on `feat/mcp-app-bridge`.

- `4389649e`: checked image/edit/processing/auto-start defaults; stored choices, disabled processing in legacy settings, and existing grants remain unchanged.
- `139c7bf8`: remove the enrollment window, its button and opening IPC. Accept new requests for the running session; retain mandatory local approve/deny, cookie/PKCE binding, individual request expiry, bounded pending requests and terminal shutdown refusal.
- `52f5c940`: update connection guidance and native/UI acceptance; allow an isolated native-smoke port so the running user's listener is not interrupted.
- `2496454d`, `8d6c4cde`: exercise the real trusted IPC controls and typed lifecycle fixture after removal; cover foreign sender/frame rejection, malformed inputs, offline approval rejection, and absence of the retired opening IPC.

Full repository `node scripts/check.cjs` passed **26/26 stages**, exit 0, **166.74 seconds**. Vitest reported **7,029 passed, 0 failed, 11 skipped/pending, 7,040 total**. All existing coverage floors remain: 750 existing files, 731 introduced records, 10 recorded deletions. The initial run exposed an IPC coverage ratio regression after deleting a handler; behavioral tests were added rather than lowering a floor. A test-fixture type error was corrected using the repository's complete typed fixture before this successful run.

Separate native Electron smoke passed all completion markers (encrypted approval restoration/refresh/revocation, masks, editable blocks, actual renderer and PNG). It used port `38476`; the user's running app on `38475` (PID 3264) was not stopped or reconfigured. No authorization or preference files from the real library were edited. As before, heavy model inference uses deterministic fixtures and logged-in ChatGPT acceptance is separate.

The production settings captures at 1600x980 and 1240x760, plus pairing/error states, passed and were visually inspected: four checked options, no timed-enrollment button, online/offline guidance and reachable number-confirmation controls. The temporary capture copies and QA entries are cleaned up; diagnostic logs remain under `.tmp/mcp-master-audit/` as `always-available-full-check-verified.log`, `always-available-native.log`, and `always-available-ui.log`.

Evidence SHA-256 at completion: check timings `aa5fcefc79e8702726ca2c3a81fb1e7166c700cee16910a8aad43a1a539c0c02`; Vitest JSON `a42784d46fb027a7ebff8e6fdfbc5241300b055eb16d484e9ce30d815f973074`; coverage summary `40cb6aa25e631f8b10b18a5ead0f58231dd85cf86c09d0b2b234563de5991b0e`. Shared report paths are overwritten by subsequent test runs. Existing dependency-advisory and model-quality limitations below remain separate; no dependency changes were made.

## Prior integration checkpoint

- Worktree: `$HOME/Downloads/CarrotMangaTranslator-MCP-Review` on the user's `4090desktop`.
- Only publication branch: `feat/mcp-app-bridge`; keep PR #96 draft. Do not release, force-push or modify master.
- Initially integrated master `10aaf439cae443fd12f4af5e7f889fb8d4c1e376` (v2.7.6) with MCP `de8511cac042ec87e90babccd359950a4060d7d8` in `1bdb2fba`.
- Latest upstream included: `a44607743f9dcd96d083efe4f1962c79e47339e3` (v2.7.7), including output cancellation/page-lock repairs, in `77d3d53c2249e57949b297d677e0ab0c7c89768f`.
- All verification below was run against exact code `77d3d53c2249e57949b297d677e0ab0c7c89768f`. Subsequent review-record edits are documentation only.
- The original checkout, independent MCP test clone, dirty font-palette worktree, user libraries and saved authorization were not edited by these tests.
- Remote Desktop Commander executed the work directly. No Codex model, Bug Hunter or Impeccable skill invocation is claimed.

## Repaired integration and behavior

Nine initial conflicts were reconciled without discarding either parent's protections. Master transaction publication/beforePublish remains the third argument; optional MCP commit-time authorization is the fourth. Monotonic timestamps, reading-order protection, full remote revision checks and both event contracts remain. Existing coverage floors were not lowered.

- `a08351f1`: preserve the actual app activity owner through asynchronous MCP OCR/export execution. A regression first reproduced the self-lock failure, then passed with `app.jobs.run`.
- `aaee7d40`: reject obsolete status polling results, recover transient read errors and avoid duplicate polling after effect replay; preserve operation errors.
- `87f8fbae`: changing auto-start alone or saving identical permissions no longer restarts the listener or cancels work. Actual permission changes still restart safely.
- `a0aefeee`: record the real combined consumers of existing library/revision boundaries; no copied authorities or relaxed generic limits.
- `5b65d885`: fix checkbox/label layout and excessive paragraph spacing, label requested scopes clearly, and explain cancellation when processing permissions change.
- `d1f90500`: cover publication rollback/commit boundaries, permission presentation and the merged coverage inventory.
- `77d3d53c`: include the newer upstream cancellation fixes; reconcile the single inventory-test conflict to 750 existing and 731 introduced files, keeping every prior metric intact.

## Completed administrator verification (2026-09-15 local / 2026-09-14 UTC)

The remote process was confirmed elevated. The unchanged `mcpSecureStore.test.ts` passed all four tests, including creation and rejection of a file symlink. The preceding non-admin `EPERM` fixture failure is resolved; no test was skipped or weakened, and no OS security setting was changed.

- Focused merge suite: **286 tests / 37 files passed**.
- Full repository entrypoint `node scripts/check.cjs` (the same entrypoint as `npm run check`): **26/26 stages passed**, exit 0, 231.09 seconds.
- Full Vitest result: **7,022 passed, 0 failed, 11 pending/skipped, 7,033 total**. These are actual reported counts, not inferred from the focused suite.
- Coverage gate: **750 existing Windows records, 731 introduced records (32 UI smoke-only), 10 deletions**, passed without lowering floors. Lines 84.38%, statements 83.07%, functions 84.96%, branches 75.99%.
- Complete Windows build, native page-artwork/PSD parity, long-path image protocol, renderer/preload bundle boundaries and all preflight gates passed. Both raster comparisons had zero mismatched pixels.
- Separate real Electron MCP smoke passed with all explicit terminal markers: OS-encrypted authorization restore/refresh/offline revocation, new blocks, original crop/mapping, saved context, real masks/storage/history/rendering, original-size PNG and revoked link refusal.
- Production settings screenshots were recreated and visually inspected at 1600x980 and 1240x760, including approval and error states. Checkbox labels remain inline; no external overflow; approval/rejection/revocation controls remain reachable by the owned scroll area. Temporary QA source entries were removed by the runner.

## Local evidence and acceptance limits

Logs are under `.tmp/mcp-master-audit/`: `admin-secure-store-20260915-000603.log`, `admin-merge-focused.log`, `admin-full-check-77d3d53c.log`, `admin-native-77d3d53c.log` and `admin-ui-77d3d53c.log`. Reviewed captures are in `.tmp/mcp-ui-qa-admin-77d3d53c/`. Machine-local evidence is not committed as user data.

Exact SHA-256 values of the completed full-check evidence:

- `.tmp/check-timings.json`: `2ac5d03834ad861c2656bd1078505593698955fc6ef6b5a8d3dc4d6ba64ffa30`
- `.tmp/check-results/vitest.json`: `ce8b9fcb960f0aa71efd1bb7ac21c536e4f1b975502f65b6afc8320ed5d20c09`
- `coverage/coverage-summary.json`: `24b2cb52a8be4e6fcec00eb1d493ad30e998e9a7cdbeace4e4493e4f8cbc1835`

This is a real local Windows full-check success, not a claim about every CI platform or every possible bug. Heavy model inference in the native page fixture is deterministic; actual model quality and a logged-in ChatGPT/Tailscale session were not exercised. The recorded dependency audit still has 9 advisory findings (4 high, 5 moderate); no automatic dependency upgrade was performed. Dependency/runtime remediation remains a separate compatibility task, not part of the check's success claim. Resume granular feature work from `mcp-page-goal.md` on the same branch.
