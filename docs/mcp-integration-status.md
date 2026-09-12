# MCP single-branch integration

The only MCP development branch is **`feat/mcp-app-bridge`**, draft PR #96. Do not create another MCP/test/recovery branch, force-push, merge into master or release an application as part of this work.

## Source publication completed

`53de254a9c456b316a63409e649418b1505596a5` merged the existing MCP branch with the recovered publication history `8e943038a170fa71e8825371e3bd7db58961e2be`. Both histories are retained. The result includes Tailscale-only desktop ownership, OS-encrypted persistent authorization, local approval/on-off/revocation, and existing translation-text editing through app transactions.

No separate bundle import is required by users. Old delivery instructions to create a new MCP test branch are superseded by [the current guide](mcp-tailscale-testing.md).

## Fresh verification

The unified source at `2662e4dd618ee0b53c11ad5512703ef451892bd8` passed **183 focused tests in 22 files** in the editing environment. That environment's overlay filesystem returns EIO on fsync; rerunning with a real tmpfs temporary directory (`TMPDIR=/dev/shm`) passed without changing production durability code or tests.

Windows run `34682609128` tested the formatted tree at `8b2d5c6f9cbc1376457ccb7cc1e21d55f1f916b5`. Its focused tests, complete Windows app build and actual Electron smoke passed, including the required marker `PASS native OS-encrypted OAuth restore, refresh and offline revocation`. All static gates except unused exports passed. Two unused exports were corrected in `a78c1bc94f0f98286a684f146387dbc1c4513f85` without relaxing a check.

The subsequent checkpoint expands focused coverage to the existing library save/revision/refresh tests and deletes only already-merged MCP recovery refs after validation. The production settings screenshot runner additionally checks wide/narrow, pairing and conflict-error layouts with synthetic data. Record the completed run and exact commit after these stages finish; a started or queued workflow is not a passing result.

## Acceptance boundary

A full repository `npm run check`, actual Tailscale account/public endpoint, and logged-in ChatGPT authorization/interaction are not proven by the focused checkpoint. UI browser captures and human visual inspection need their own recorded results. No private library, account secrets or user images are uploaded by the synthetic tests.

For continuation, inspect the latest checkpoint and exact branch tip, correct actual failures, and update PR #96. All further work and commits stay on this same branch. Preserve the distinctions between server off/on (authorization retained), revocation (persistently denied), and token expiry/refresh.
