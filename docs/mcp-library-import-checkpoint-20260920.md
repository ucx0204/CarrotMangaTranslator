# Bundle 10: file/web import and library organization

Latest continuation: `mcp-library-import-connected-checkpoint-20260920.md`.
The reviewed native-file/single-URL import slice passed all 26 gates and the added
actual-Electron import/reconstruction scenario at `f4ea5e0c`. Bundle 10 still needs
multi-URL discovery/resume, persistent source deduplication, library organization
and general file exchange. Earlier pending notes below are historical.

Status: IN PROGRESS. Starting checkpoint: `d7b86ebf`.
Continue only on `feat/mcp-app-bridge` in the existing MCP-Review worktree.
Bundles 1-9 remain implemented. Live user/model/client testing is deferred.

## Implementation sequence

1. Connect reviewed file and web-image imports to the existing native importer.
   Local files must be chosen through the native picker or actually uploaded;
   remote callers cannot submit filesystem paths or another UI's preview ID.
   Preserve ordered selections, immutable source evidence, current destination,
   authorization at publication, cancellation and exact retry receipts. A completed
   import and its encrypted receipt must share the native transaction.
2. Add bounded chapter discovery/selected multi-URL continuation and persistent
   source identity for duplicate detection. Discovery is not proof of exhaustive
   access. Do not bypass login, CAPTCHA, private-address or redirect protections.
3. Connect existing library naming/order operations and explicitly reviewed
   destructive/move actions with appropriate preservation/recovery semantics.
4. Complete input exchange, native/HTTP/edge-case tests, full repository gates,
   measured coverage inventory and precise handoff. Do not start bundle 11.

The web-image manager currently shares a UI temporary root when constructed with
normal app paths. Any MCP-owned manager must use its own isolated temporary root;
initializing or disposing it must never remove the UI's scans or import previews.

The native importer already stages images and publishes chapters atomically, but
its current public call does not accept a live commit guard or a coupled import
receipt. Add a trusted optional native publication boundary without changing the
existing UI/import semantics. Do not replace the importer, image validator, archive
reader, PDF converter, library locks, activity gate or transaction recovery engine.

A preview is temporary; a completed import is ordinary library data. Receipts are
bounded audit/replay metadata, not an assertion that imported chapters still exist
or that source previews can be restored after restart. Report limits explicitly.

No user artwork, credentials, running app, Tailscale configuration, model assets,
master branch or releases may be changed by this development/verification task.
Actual implemented tools and successful verification will be recorded below;
this initial document is not a completion claim.
