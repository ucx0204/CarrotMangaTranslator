# MCP single-branch integration

The only MCP development branch is **`feat/mcp-app-bridge`**, draft PR #96. Do not create another MCP/test/recovery branch, force-push, merge into master or release an application as part of this work.

## Current first-page milestone

The connection/existing-edit baseline below is historical. New external blocks, source crops, saved context, optional OCR-only work, independent local erasure and rendered PNG are now implemented on the same branch. Current contracts, recovery commits and exact acceptance boundaries are in [mcp-page-goal.md](mcp-page-goal.md); user instructions are in [mcp-page-testing.md](mcp-page-testing.md). Do not use the old remaining-work list below as the current feature inventory.

## Source publication and branch consolidation completed

`53de254a9c456b316a63409e649418b1505596a5` merged the existing MCP branch with the recovered publication history `8e943038a170fa71e8825371e3bd7db58961e2be`. Both histories are retained. This is actual source publication, not an unapplied patch or ZIP. No separate bundle import is required by users; old new-branch instructions are superseded by [the current guide](mcp-tailscale-testing.md).

After verifying their expected tips and ancestry, Windows checkpoint `34682973978` removed the three merged reference names: `backup/mcp-before-publication-20260912`, `backup/mcp-before-tailscale-checkpoint-20260912`, and `integration/mcp-tailscale-publication-20260912`. Their commits remain reachable through the consolidation merge. A subsequent GitHub branches read confirmed that only `feat/mcp-app-bridge` remains for MCP work. Unrelated branches were not removed.

## Verified Windows checkpoint — SUCCESS

**Exact source commit: `baf2df764d5deadc40d94291233835ca44dffa70`.**
[Run 34683291856](https://github.com/ucx0204/CarrotMangaTranslator/actions/runs/34683291856), job `103525734392`, completed with **success** on 2026-09-12 at 08:32 UTC. The workflow made no additional formatting commit for this tree.

- **183 focused tests in 22 files passed**, covering MCP plus existing library save, page revision, chapter sync and live refresh behavior.
- **Complete Windows application build passed.**
- **Actual Electron smoke passed**, including synthetic library import/preview, redaction refusal, listener shutdown, real OS-encrypted OAuth persistence, restoration in fresh service instances, refresh rotation and offline revocation. The explicit native completion markers were required.
- **Production settings browser QA passed** at 1600×980 and 1240×760, with approval and conflict-error states. The four PNGs in artifact `10294497746` (`mcp-settings-ui`) were downloaded and visually inspected: no horizontal overflow or overlapping controls; long addresses and text fit; approval, rejection and revocation controls are reachable through the modal's internal scroll.
- **All 12 static gates passed:** the three typechecks, formatting, dependency rules/budgets, error handling, ESLint, unused exports, script entrypoint inventory, maintainability and duplicate checks. No gate was disabled or weakened.

The preceding unified run `34682609128` passed tests/build/native checks but reported two unused exports. Those exports were made private in `a78c1bc94f0f98286a684f146387dbc1c4513f85`; run `34682973978` then passed all its gates. The final successful run adds the actual screenshot stages and replaces stale web instructions.

The local unified focused run also passed all 183 tests with `TMPDIR=/dev/shm`. This isolated editing environment's overlay filesystem returns EIO on fsync; using real tmpfs for test temporary directories required no change to production durability code or assertions.

## Product behavior in this checkpoint

Tailscale Funnel only, no Cloudflare fallback. App on/off and restart preserve valid OS-encrypted authorization. Explicit connection revocation remains effective after restart. Pairing is approved in the trusted desktop UI with a matching browser code, not by copying a password from a terminal. Images and existing translation edits are separately opted in and scope-checked. Existing text edits use the app's transactions, full revision and dirty-editor safeguards; geometry, fonts, masks and unrelated data are preserved.

The user guide is `docs/mcp-tailscale-testing.md`. Normal startup is `npm run dev`, then **Settings → AI 연결 / MCP**. The retired web password-file diagnostic no longer reads credentials. The local Bearer development profile remains separate and documented in `docs/mcp-testing.md`.

## Honest acceptance boundary and continuation

This is a focused Windows checkpoint, **not a claim that every platform or the entire repository `npm run check` passed**. The native persistence test reconstructs real service/store instances; it is not a whole-PC reboot test. GUI captures use real production components/styles with synthetic state, not a logged-in user library.

**Actual Tailscale-account/public-endpoint and logged-in ChatGPT approval/tool interactions still require separate acceptance.** Installation/login and account-level Funnel/HTTPS permission are user setup. No private account credentials, libraries or user images were uploaded during the automatic tests.

New external-agent blocks, independent OCR/erasure/lettering jobs, rendered export/ZIP, SFX image generation, import and research batching remain beyond the existing-text editor. All further implementation and commits stay on this same branch. Inspect the exact remote head before writing and record fresh results instead of inferring success from this historical checkpoint.
