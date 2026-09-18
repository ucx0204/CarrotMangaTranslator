# Bundle 4 image editing checkpoint - 2026-09-19

Baseline: `25bbe155`. Work only on `feat/mcp-app-bridge` in the existing
CarrotMangaTranslator-MCP-Review worktree. Bundles 1-3 are completed with automatic
checks; all live model/user/client acceptance remains deferred.

Status: implementation in progress; no new image-edit tools verified yet.

## Scope

One explicitly versioned page per image edit, with up to 100 selected blocks.
Native block-mask calculation, freehand erasure masks, explicit protected geometry,
model-free paint/original-pixel restoration, mask inspection and color sampling.
Preserve existing cleaned pixels, source files, text, block geometry and formatting.
Use the native model lease, page handoff, persistence and image history rather than
a second queue, image store or erasure algorithm. Exact session undo/redo must not
repeat inference. Persistent recovery remains bundle 7; chapter orchestration is 8.

Prepare/inspect is separate from explicit application. Only the configured local
engine may execute, with explicit approved asset-download permission; no hosted
image service, OCR, translation, C23, layout or renderer pipeline is implicit.
White paint is an explicit retouch command, never a substitute erasure engine.
Preview images and color samples retain image permission and redaction checks.

## Required verification

Native mask parity; selected/protected/outside-pixel preservation; exact original
restoration; real isolated persistence and history; stale page/image conflicts;
wrong owner, malformed input, request replay, cancellation and cleanup failure;
permission revocation before publication; complete static, coverage and build gates.
Do not alter user artwork, authentication, approved assets, the running app, master,
or releases. Record exact verified commits and remaining work before handoff.
