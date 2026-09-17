# MCP block OCR: real Hayai empty-result fix

## Cause and scope

The original `carrot_run_block_ocr` adapter cropped the correct original pixels,
but the Hayai prepass then treated that narrow crop as an unknown full page.
For both reported synthetic blocks the page detector produced no dialogue/effect
regions. The raw Hayai payload and normalized hints were therefore both empty.
The issue occurred before text recognition, not in the MCP text projection.

A diagnostic run of the actual built app executor captured the temporary crop,
region manifest and raw OCR payload before normal cleanup. Its 280x42 crop hash
was exactly the same as the previously failing MCP observation. The manifest had
zero dialogue and effect regions; raw `items` and final `hints` were empty.

`4bdfbaac` introduces an internal `ocrInputKind: known-block-crop` option set by
MCP block OCR. The existing Hayai prepass builds one immutable full-crop region
instead of redetecting a region the app already selected. Normal page OCR still
uses the existing detector and receives no fallback region on an empty result.
The placeholder detector score is zero: it is not claimed recognition confidence.

The selected engine, device, language, pinned Python runner and model are unchanged.
Page ownership, revision checks, cleanup barriers, no-auto-apply and metadata-only
responses remain in place. No new scheduler, parallel inference or tool was added.
The regression-first commit `bb5d96fa` failed one adapter assertion before the fix.

## Real installed model and live MCP

The real-runtime diagnostic reran both original crops sequentially after compiling
the fix. Its crop hashes and configured source language (`ja`) were unchanged.

The normal application was then closed using its normal window-close request,
not force-terminated, and restarted with the same worktree's `npm run dev`.
Its persistent server/data-profile IDs remained identical and runtime ID changed.
Existing MCP authentication worked without reconnecting or editing credentials.

| Live target | Before fix | After fix | New live job |
| --- | --- | --- | --- |
| `external.png`, 280x42 | Empty | `HELLOWORLD` | `6ecbcb35-565b-4694-af5c-a52377a3c7dc` |
| `ocr.png`, 271x36 | Empty | `TEST PAGE 123` | `fc3e4084-c307-419c-8056-a100ba2bbfdc` |

Both new jobs were polled to `completed`, with `noTextDetected: false`, one
recognized region and `pagesChanged: 0`. An exact repeated request for the second
job returned the same ID/result, without creating a new job. No file tool ran.
`HELLO WORLD` loses a space in Hayai's actual result: this remains a recognition
quality limitation, not silently repaired from the saved source or auto-applied.
Both observations remain review-required. No user text was overwritten.

Original crop SHA-256 values were unchanged before/after the fix:

- HELLO: `231c7c8d388a273d15acfa12f3dc7f237b1af3075b6ca6aa92882ae895517aa2`
- TEST: `f7e461aeea9cb3ca239a91b85a5179d95366b0c482f5c9125b1cd9c61b0b4c35`

A byte-hash comparison of 11 files (chapter JSON, original pages, inpainted image,
mask and existing OCR caches) found no changes. Both live crop directories were
removed after cleanup. Only job records and disposable diagnostic artifacts were
added. No language/model setting or authentication configuration was changed.
