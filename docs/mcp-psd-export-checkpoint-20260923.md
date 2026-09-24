# Bundle 11: native layered PSD output

Status: IN PROGRESS. Starting checkpoint: `e3c92d16`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
GitHub owns source/test/document writes; Remote Desktop Commander verifies them.
Preserve user manuscripts, credentials, model assets and Tailscale configuration.
Do not restart the user app or run live acceptance. Bundle 12 remains deferred.

## Intended slice

Reuse the native PSD layer capture and writer, not a second serializer or a flattened
image renamed as PSD. Keep existing PNG/JPEG/WebP contracts and export jobs intact.
Add an explicit PSD command using the same reviewed page selection, job, artifact,
ZIP and retained-output paths. Polling remains metadata-only; file delivery is explicit.

Require acknowledgment that PSD contains the ORIGINAL background layer, even when
a cleaned background exists. Also acknowledge that native unsupported typography or
generated lettering remains a faithful raster layer rather than editable text.
Fonts, full edit history, masks and profile state are not a PSD backup guarantee.
Use bounded layer/pixel memory and output sizes, with no silent downscaling.

## Validation to finish

Strict schema/permissions, source and redaction changes, cancellation/cleanup,
partial export, actual layer parsing and original/composite preservation, explicit
HTTP file delivery/ZIP and retained byte-identical reissue after reconstruction.
Preserve all existing quality criteria and record exact automated/native results.
Working-file output, text/context exchange, source-format policy and delivery/sync
remain later slices of bundle 11; completed raster output must not be recreated.
