# MCP single-branch integration

The only MCP development branch is **`feat/mcp-app-bridge`**, draft PR #96. Do not create additional MCP/test/recovery branches, force-push, merge into master or release automatically. Tailscale Funnel only; encrypted persistent authorization is required. No Cloudflare fallback.

[First-page user test](mcp-page-testing.md) · [Connection guide](mcp-tailscale-testing.md) · [Functional contracts](mcp-page-goal.md) · [Coverage evidence](mcp-page-coverage-evidence.md)

## Current deliverable: first complete page

Source reads and crops, saved work context, external reading/translation block creation, optional local OCR-only processing, standalone local erasure, current-state app rendering and original-resolution PNG are implemented and published as source. Each is separately callable. The connected AI supplies the translation in this route; no Codex or paid text-model fallback is invoked.

Keep existing source/geometry/masks/styles and library transactions authoritative. New-block writes require current page revisions. The same activity/job gate protects local heavy operations. A second inference queue, renderer, OCR algorithm or library is not introduced.

Permissions remain separate: `carrot.read`, `carrot.images`, `carrot.edit`, and the new `carrot.process`. Enable local processing in app settings and explicitly authorize that scope. Existing grants are not expanded by a preference change. Valid connections retain their Tailscale address and OS-encrypted authorization after normal stop/restart.

## Verified first-page baseline

**Commit `421922d56f3d6cb00936cb90753442082a94b407`, Windows MCP run `34733470908`, completed successfully on 2026-09-13.** That checkpoint ran the focused suite, full Windows app build, real Electron page-chain and encrypted authorization smoke, production settings captures, and static gates including test-mock boundaries.

The native page chain executes real block persistence, mask construction, inpainting composition/history, renderer assets/fonts, original-resolution PNG and file-access revocation. Only the expensive model inference boundary is deterministic. This is not evidence of real OCR/model accuracy or a logged-in user's new-tool session.

## Resumed regression checkpoints

- `27f2027c` exports the exact source and coverage scope on this same branch. Source restoration matched the remote Git tree; no obsolete archive was treated as current source.
- `1c766a4b` adds three real preload/gateway regressions: validated MCP events, listener cleanup, dirty-editor reports, and inert test defaults. No application module is mocked and no coverage floor is lowered.
- `b01ca6f4` permits only the exact coverage JSON path in the existing source-checkpoint delivery workflow. It does not modify the coverage checker or thresholds.
- Checkpoint `e4b46d2e` was applied by the branch-local workflow. The destination coverage manifest blob is verified as `2dbc78e8abb70f92dc72b47165d17f7be03134f0`; 68 newly tracked rows use actual Windows measurements, while every previously recorded floor stays unchanged. The patch is removed after application, not left as the implementation.
- `085982c0` records the measurement run, artifact IDs and SHA-256 values in the coverage evidence document.
- Checkpoint `1ba5aabf` was applied in `789e5bc3`: native readback now proves crops still contain original text after erasure, crop-to-page coordinates are correct, the saved-context tool resolves the same work, and rendered previews contain translated lettering. The verified script blob is `fba38ab3661e2a202ac73992829114ef4f640ece`.

The previous PR-wide `Check` run `34733472515` had **6826 passing tests, one coverage-inventory assertion failure and 11 skipped tests**. It must not be reported as success. The inventory assertion exposed newly touched existing files and newly introduced MCP files missing from the existing coverage manifest. The follow-up preserves the checker, old floors and mock restrictions, adds measured rows, and covers the preload callbacks that had lowered existing ratios.

Locally the available focused suite passes **245 tests in 36 files** with `TMPDIR=/dev/shm`. The four erasure cases require an ONNX binding omitted from the offline Linux dependency kit; they remain enabled and must run in Windows CI. The new preload-focused run passes 24 tests; its single excluded all-IPC registration case has the same local binary limitation, not a source-level skip. CheckJS and focused ESLint pass for the native readback change. Final Windows MCP and full PR `Check` results must be read from the exact final run and recorded in PR #96 after completion; no pending job is a successful check.

## Publication and branch history

`53de254a` consolidated the original MCP branch and recovered source history. Three exact, already merged recovery references were removed after ancestry checks. Their commits remain reachable. No unrelated branch or user data was deleted. Users update the original clone with `git pull --ff-only`; old ZIP, patch import and additional-branch instructions are obsolete.

The user confirmed Tailscale/ChatGPT connection, persistent authorization and existing-text editing before this first-page milestone. Historical baseline `baf2df76` / run `34683291856` passed 183 focused tests, Windows build, native auth/preview and settings captures. It is not a substitute for current first-page verification.

## User acceptance and remaining scope

Test one public, block-free page first. Read saved context and source/crops, submit the connected AI's reading/translation as editable blocks, request local erasure separately, then render and export. OCR-only is optional and does not translate. See the Korean first-page guide for prompts and job polling.

Derived output is currently blocked when external-image redaction is enabled; source/crops still follow the existing review guard. Do not disable protection for private material merely to pass a test. PNG links are single-file capabilities lasting ten minutes, invalidated by stop, revocation or relevant page changes. Session receipts/output links do not survive restart; stored page data and valid authorization do.

Actual model quality and the logged-in user's new-tool experience remain separate from deterministic tests. Independent app text-model execution, AI font matching, existing geometry/style/mask editing, SFX image generation, derived-layer review, durable multi-page jobs/ZIP, imports and research/context replacement remain future work. Do not describe this milestone as all app functions being exposed.
