# MCP explicit file retrieval acceptance — 2026-09-16

Branch: `feat/mcp-app-bridge`. Code checkpoint: `77433108219533918216d6776d6c72146ea3ec50`.

**Closeout:** Both outstanding verification items below have since been resolved.
See [the final closeout](mcp-job-file-closeout-20260916.md) for successful actual
connected status/export calls and the updated standalone native smoke. The limits
below describe this earlier checkpoint, not the current state.

The user's pending status/file separation was reviewed and retained. Normal job
status, listing, cancellation, duplicate starts and retry receipts return only
allowlisted result metadata. They contain no artifact URL or resource link.
`carrot_get_job_file` explicitly retrieves an owned, settled, completed PNG under
both read and image scopes, rechecking file availability, revision and redaction.
It never starts rendering to replace an expired output. Image preview tools remain
explicit image-producing tools; no approval or permission protection was removed.

Shared job-ID schemas remove an introduced duplicate. Additional tests exercise
missing-file, filesystem denial, malformed/foreign output URLs, changed byte size,
missing scope checks and malformed result metadata. Existing coverage floors stay
unchanged; no allowlist or quality gate was weakened.

## Verified

- Full `node scripts/check.cjs`: all 26 gates passed.
- Full suite: 7,150 passed, zero failed, 11 pre-existing skipped tests.
- Build, three typechecks, lint, architecture, unchanged coverage floors, renderer
  parity, image protocol and bundle checks passed.
- Focused HTTP tests cover repeated metadata-only polls, listing, cancellation,
  duplicate export/retry, explicit file retrieval, owner isolation and revocation.
- The running app's capabilities now include `carrot_get_job_file`.

## Explicit limits / remaining test-harness compatibility

The separate `scripts/mcp-electron-smoke.cjs` was run on isolated port 38679.
It passed encrypted authorization, real app editing/erasure/rendering, review,
and the 162-case hostile-input matrix across 23 production tools. It then failed
with `ERR_INVALID_URL` because `scripts/mcp-native-page.cjs` still reads
`result.url` from the now metadata-only `carrot_get_job` response. This is an old
test consumer, not evidence that the status tool should return the URL again.
The attempted update to this native test consumer was rejected by the tool safety
check and was not retried through another route. Do not claim this standalone
native smoke or the MCP checkpoint workflow is fully green after the API change.

The actual ChatGPT connection returned current capabilities and read the separate
synthetic test work, but several fresh export and known-job calls returned
`Connection failed`; an unknown-job query returned the expected not-found error.
Local and public OAuth discovery both returned HTTP 200. This does not establish
why those particular calls failed. Do not claim the ChatGPT attachment dialog has
been observed to disappear, or disable authorization to work around it. This
conversation still exposes the older 16 tool definitions, not the new file tool.

No user page, original image or authentication file was directly edited in this
continuation. A running Review app appeared during checking; duplicate startup
was refused and unrelated apps were not stopped. Logs are in
`.tmp/mcp-attachment-final-20260916/` (acceptance, focused, native and build logs).
