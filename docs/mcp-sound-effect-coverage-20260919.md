# Sound-effect coverage evidence - 2026-09-19

Baseline: `f6257058`. Initial measured production/test code: `1984d8ac`.
The first complete Vitest/V8 run passed 7,850 tests with one inventory-registration
failure and 11 pre-existing skips. Its only failure named the 18 new modules below.
No sound-effect behavior or previous feature regression failed in that run.

All 1,625 inherited records (753 original and 872 introduced), their global
provenance and ten recorded deletions were compared with the baseline and preserved
exactly. Only these 18 actually measured modules were added. The final inventory is
753 original plus 890 introduced, 1,643 total. No existing module floor, global
coverage threshold or check was reduced. The exact coverage-floor command and its
27-test inventory suite passed after registration.

Initial coverage summary SHA-256: `c8d623f0da686afd55cb6539ed52aea3cc921d5b0aa6e2811030bace9d4a7eab`.
Per-module measured metrics and inheritance comparison:
`.tmp/mcp-sfx-coverage-evidence.json`. Final full-check and native results belong in
`mcp-sound-effect-checkpoint-20260919.md`; do not substitute this initial report for
the final rerun.

| Module                                                |  Lines | Statements | Functions | Branches |
| ----------------------------------------------------- | -----: | ---------: | --------: | -------: |
| `src/main/application/mcpSoundEffectBlocks.ts`        | 88.88% |     84.84% |      100% |   77.77% |
| `src/main/application/mcpSoundEffectPolicy.ts`        |    95% |     95.23% |      100% |      75% |
| `src/main/libraryStore/librarySoundEffectSnapshot.ts` | 95.65% |     82.75% |      100% |   68.75% |
| `src/main/mcp/mcpCandidatePng.ts`                     | 81.81% |     81.81% |      100% |      50% |
| `src/main/mcp/mcpSoundEffectAdapter.ts`               |   100% |       100% |      100% |     100% |
| `src/main/mcp/mcpSoundEffectCommands.ts`              |   100% |       100% |      100% |   88.88% |
| `src/main/mcp/mcpSoundEffectEdits.ts`                 | 83.01% |     85.24% |      100% |   68.96% |
| `src/main/mcp/mcpSoundEffectGeneration.ts`            |  93.5% |      92.4% |    93.75% |   72.72% |
| `src/main/mcp/mcpSoundEffectImageTool.ts`             | 90.62% |     90.62% |      100% |   81.25% |
| `src/main/mcp/mcpSoundEffectLayer.ts`                 | 83.33% |     83.33% |      100% |      60% |
| `src/main/mcp/mcpSoundEffectPreparation.ts`           | 89.28% |     89.65% |      100% |   71.42% |
| `src/main/mcp/mcpSoundEffectPrepareTools.ts`          |   100% |       100% |      100% |   93.75% |
| `src/main/mcp/mcpSoundEffectReadTool.ts`              | 89.47% |        90% |      100% |   85.71% |
| `src/main/mcp/mcpSoundEffectSession.ts`               | 95.65% |     95.65% |       90% |     100% |
| `src/main/mcp/mcpSoundEffectSettings.ts`              |   100% |       100% |      100% |      50% |
| `src/main/mcp/mcpSoundEffectState.ts`                 |   100% |       100% |      100% |   80.48% |
| `src/shared/mcpSoundEffects.ts`                       |   100% |       100% |      100% |     100% |
| `src/shared/soundEffectPageSnapshot.ts`               |   100% |       100% |      100% |     100% |

## Existing boundaries and exact architecture declarations

Runtime import and consumer defaults remain 12 and 25. Native source hashes,
page/review revisions, typed errors and atomic library storage are reused directly.
Only exact existing public-authority/composition counts were declared: logger 39,
pageRevision 62, blockFingerprint 54, mcpEditPolicy 108, library facade 63,
libraryFiles 26, output schemas 20 imports, page-operation composition 27 imports.
The new preparation implementation was split into command calculation and evidence
validation to remain below the normal import ceiling, not given an exception.

The bounded native PNG projection was extracted from the already characterized
external-image preview and is shared by sound-effect assets. Existing external-image
regressions passed after that extraction. Existing sound-effect restoration was
exported without changing its algorithm; existing image-client configuration was
narrowed at the TypeScript boundary only, leaving account and model validation intact.

## Interpretation

Tests use actual isolated native review algorithms, source crops, foreground/matte
processing, library transactions, page ownership, job persistence and OAuth/HTTP.
Only external Electron image calls and Codex transport are substituted in generation
unit fixtures. This does not prove live inference quality, provider quota or actual
client image reception. All such acceptance remains in the final live-test queue.

## Final verification

All 26 repository gates passed at `d5db3901`: 7,851 passed tests, zero failures,
11 pre-existing skips, and 1,037 MCP cases across 150 files. The exact coverage-floor
gate passed on that full rerun. All inherited records and provenance remain intact.
The model-free native Electron sound-effect check and full smoke completion marker
also passed, with exit code 0. Final evidence: `.tmp/mcp-sfx-final-evidence.json`.
