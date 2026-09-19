# Bundle 8: connected workflow completion checkpoint

Status: IMPLEMENTATION CONNECTED; FINAL AUTOMATIC VERIFICATION IN PROGRESS.
Current source/test candidate: `ac01503f10eaeab72681bd0c2e6328fef90eaac4`.
Continue only on `feat/mcp-app-bridge` in `CarrotMangaTranslator-MCP-Review`.
This file supersedes the remaining implementation list in
`mcp-workflow-continuation-20260919.md`.

Translation/erasure model-group residency, settled workflow admission, atomic
two-party handoff, four additional registered tools and strict output schemas are
now connected. The old two function-length errors are fixed. Native transaction
verification reuses the canonical context snapshot without reacquiring its own
read lock. Existing history/output ownership is not transferred with a plan.

Current-child cancellation was reproduced as three failing tests and corrected.
Ended children's abort handlers cannot affect later borrowers. Native pool tests
cover three inpainting engines with one shared lease and one physical disposal.
The compatibility runner test now imports native modules after isolated environment
setup, consistently with the actual integration fixtures.

The first full connected run had 7,959 passes, one missing coverage-inventory row
set and eleven skips. Five modules were registered from that real measurement.
The next complete behavior suite passed, but exact coverage floors found three
small gaps. Additional genuine nested/expired/wrong-kind and ungrouped waiting
regressions now pass; no floor was reduced.

Read `.tmp/mcp-workflow-connected-check-final3.log` and terminal PID 18492 before
claiming final success. That command runs all 26 repository gates and, only after
success, the existing isolated real-Electron workflow scenario on port 38559 with
Tailscale disabled. Require the workflow-specific and complete-smoke PASS markers
and process exit code zero from `.tmp/mcp-workflow-connected-native.log`.

Final result counts and native evidence are not yet recorded here. Do not begin
bundle 9 until this verification closes. The running user application, artwork,
authentication, model assets and public Tailscale connection were not changed.
Live model/client acceptance remains deferred. Coverage provenance is in
`mcp-workflow-connected-coverage-20260919.md`.
