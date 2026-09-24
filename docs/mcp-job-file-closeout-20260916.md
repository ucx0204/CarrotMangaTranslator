# MCP job-file closeout - 2026-09-16

Branch: `feat/mcp-app-bridge`. Tested code: `1a2fa0c2290b4c9c9a4fbd04f9f69f31d4a583a4`.
This closes the two outstanding verification items in [the preceding acceptance record](mcp-job-file-acceptance-20260916.md).

## Actual connected ChatGPT calls

The running server advertised `carrot_get_job_file`. The existing synthetic audit
work was read through the connected MCP, then a new PNG export was requested.
The request returned a running receipt and subsequent polling returned completed.
Three completed-status queries contained only metadata: no URL, resource link or
image. Repeating the identical export returned the same job ID. Cancelling that
already-completed job retained completed and cancellationRequested=false, again
without file resources or download URLs. No Connection failed response occurred
in this sequence. Observed PNG metadata: 480 x 640, 12,297 bytes.

These calls establish the current status/export path works, not a cause for the
earlier transient failures or a promise that all ChatGPT safety prompts disappear.
This conversation still exposes the older 16 definitions. Explicit file retrieval
was therefore checked in the real native app/HTTP suites, not falsely reported as
a direct chat invocation. Exact live observations are in the ignored log directory.

## Native script compatibility

`scripts/mcp-native-page.cjs` now polls metadata, then explicitly calls
`carrot_get_job_file`. Three completed polls and a poll after file retrieval must
contain no file resources or URLs. Fixture scope checks are explicit; production
authorization was not relaxed. File resource and metadata must agree, and actual
PNG bytes must match the declared byte length and SHA-256.
Revocation blocks both the explicit file tool and artifact bytes. Restored encrypted
job history still omits expired file URLs. The standalone native smoke ends with
exit 0 and `PASS MCP native smoke finished`, rather than ERR_INVALID_URL.
Actual storage, renderer, permissions, redaction and masks are used; heavy
inpainting inference retains the existing deterministic test engine.

## Final verification

- Full `node scripts/check.cjs`: all 26 gates passed.
- Full suite: 7,150 passed, 0 failed, 11 existing skipped.
- Focused job/file/HTTP/artifact tests: 31 passed in four files.
- Native smoke: all stages completed, including 162 hostile-input checks across
  23 production tools, image rendering, auth restoration and revocation.
- Native output: 400 x 600; actual byte count and SHA-256 verified.
- The isolated listener used port 38685 and was confirmed closed afterwards.

Logs: `.tmp/mcp-file-closeout-20260916/` contains `full-check.log`,
`native-final.log`, `focused.log`, exit-status files and `live-verification.json`.

No production source, user page, authentication setting or existing approval was
changed. Live testing only rendered/exported a previously created synthetic page.
The normal app was not restarted or force-terminated. No new branch, master push
or app release was created.
