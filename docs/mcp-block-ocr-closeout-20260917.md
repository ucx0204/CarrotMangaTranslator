# MCP block OCR: implementation and isolated acceptance

## Current state

Implemented on `feat/mcp-app-bridge`. The tested code/test checkpoint is
`4b72a88418f044aa32724d7d36b17589ad7af5d9`. No new branch or batch runner was created.

`carrot_run_block_ocr` is registered in the app's page-operation composition.
It observes one existing block's current source rectangle through the existing local
OCR runtime. Original pixels, page ownership, model-runtime exclusivity and actual
cleanup are reused. The observer has no page persistence port. The existing
`carrot_update_page_blocks` sourceText field edit remains the separate apply path.

See [usage and constraints](mcp-block-ocr-testing.md).

## Resumption fixes

The implementation and most tests were already committed through `834463b0`.
This closeout did not duplicate those services or replace OCR algorithms.

- `ef80bf68`: extracted native fixture seeding within the existing script; retained
  every assertion and satisfied its function-size rule without raising the limit.
- `99b17084`: recorded the observation/apply contract and usage.
- `4b72a884`: fixed a test deadlock, exercised the actual block OCR executor,
  and registered the four new production files' measured coverage floors.

The deadlocked HTTP fixture awaited a competing same-page edit before releasing
its intentionally paused OCR operation. The real page-ownership implementation
queues that edit. The corrected test observes both active requests, verifies no
stored change, disconnects the competing editor, verifies its lease is removed,
then cancels OCR and checks that the original lease stays held until recognition
cleanup returns. The test now follows real page ownership rather than expecting
an immediate rejection. No production timeout or lock policy was weakened.

## Results rerun on the Windows PC

`npm.cmd run check`: **26 gates passed, exit code 0**.
Full test run: **7,287 passed; 0 failed; 11 existing skipped (7,298 total)**.

This includes the three type checks, formatting, lint, dependency/architecture,
maintainability, error handling, mock boundaries, duplicate/reexport/generated
checks, dead code, measured coverage protection, Windows build, real page-artwork
pixel parity, image protocol and renderer/preload bundle checks.

The block OCR groups in that full run were:

| Test file | Passed |
| --- | ---: |
| `mcpBlockOcr.test.ts` | 13 |
| `mcpBlockOcrAdapter.test.ts` | 10 |
| `mcpBlockOcrHttp.test.ts` | 4 |
| `mcpStructuredOutputs.test.ts` | 8 |

The three focused OCR groups also passed all 27 tests when measured separately.
That focused coverage command exited nonzero because the repository's unchanged
GLOBAL coverage thresholds correctly apply to the entire repository, not three
selected files. It is not reported as a successful global coverage gate. The
subsequent full run satisfied the global and per-file coverage checks.

## Actual Electron acceptance

The final isolated native command used Electron's Node launcher on port 38686:

```powershell
$env:CARROT_MCP_SMOKE_PORT = '38686'
node node_modules/electron/cli.js scripts/mcp-electron-smoke.cjs
```

It exited **0** and produced both:

```text
PASS native block OCR: original crop after erasure, unchanged observation snapshot, one inference/release, duplicate receipt, source-only apply/restore and identical rendering
PASS MCP native smoke finished
```

The same run passed 196 hostile-input checks across 28 production tools, existing
selected-erasure undo/redo, source-rectangle edit/restore, real PNG output integrity,
metadata-only status polling, explicit file retrieval and revoked file access.

The block OCR native test uses a synthetic external OCR transport ONLY. The
original-pixel crop, app executor, page/model leases, metadata results, temp-file
cleanup, existing source-field save/restore and renderer are real. It verifies
that an erased page is read from its original, one observation performs one
collect/release, repeated receipt lookup does not repeat inference, and the
source-only apply/restore leaves the expected render and image bytes unchanged.
It does not prove accuracy of installed Hayai/Paddle models or measure VRAM.

An initial direct invocation of the Windows GUI executable yielded an empty log;
its inherited/launcher exit code was NOT accepted as test evidence. Only the
subsequent Node-launcher run with all final PASS lines is the accepted native run.
The isolated listener and its test Electron process were absent after completion.

## Coverage evidence

Only these four NEW production entries were added to introducedFloors:

| File | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `src/main/application/mcpBlockOcrService.ts` | 42/43 | 31/32 | 7/7 | 40/41 |
| `src/main/mcp/mcpBlockOcrAdapter.ts` | 63/68 | 28/36 | 8/9 | 62/66 |
| `src/main/mcp/mcpBlockOcrSession.ts` | 5/5 | 0/0 | 4/4 | 5/5 |
| `src/shared/mcpBlockOcr.ts` | 6/6 | 0/0 | 2/2 | 5/5 |

The exact file inventory increased from 752 to 756 introduced files. Existing
floors, source provenance, historical artifacts and coverage gate behavior were
preserved. The actual executor test prevents registering its earlier unexecuted
0% measurement as an acceptable baseline.

Measurement and verification files remain in the local ignored directory:

- `.tmp/mcp-block-ocr-20260917/coverage-block/coverage-summary.json`
  SHA-256 `81995bd1dcce741545d0377f842e95bb4317105c94404f3bc468843211416dfd`.
- `.tmp/mcp-block-ocr-20260917/coverage-full-accepted.json`
  SHA-256 `b7c36b9a69c3fc27beb26bfeff4022f779f665218bf1cb1ccd356043af36b281`.
- `.tmp/mcp-block-ocr-20260917/check-final-attempt.log`
  SHA-256 `801560b9984e30fb04f5a691767d16bed0d7fead904dd359a54d793c026bd4f3`.
- `.tmp/mcp-block-ocr-20260917/native-cli.log`
  SHA-256 `cc6c8ac40fd05b956f3933717d8625536a177394570b65ec6b29995bec8cb7cf`.

## Live connection and remaining verification

The installed Carrot MCP connection answered `carrot_get_capabilities` successfully
at closeout. Its running normal-app feature list still did NOT contain
`carrot_run_block_ocr`. The normal app was not restarted and its stored credentials,
model settings and user library were not changed. No attempt was made to invoke an
unexposed tool, substitute whole-page OCR, or obtain hidden credentials.

Thus this feature is implemented and verified by unit, OAuth HTTP and actual
isolated Electron acceptance; **live chat invocation with a real installed OCR
model is still pending**. After a normal app restart and client tool-definition
update, use a disposable test block, observe without saving, inspect the completed
job result, and explicitly apply/restore sourceText. Verify stored geometry,
translation, other blocks and images remain unchanged. Do not reuse stale results
by replacing their original observation revision with a new revision.

No user pages were changed in this closeout. All mutation checks used isolated
fixture libraries. No OCR/inpainting model was downloaded or executed against the
normal user library. No batching, automatic translation, automatic application or
permanent erasure-history feature was added.
