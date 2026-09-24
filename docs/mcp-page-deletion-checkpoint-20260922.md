# Bundle 10 continuation: reviewed page deletion and recovery

Latest completion: `mcp-page-deletion-connected-checkpoint-20260922.md`.
Page tools are registered and all 26 gates plus dedicated actual-Electron recovery
passed at `8252872c`. The initial planning/status below is historical and does not
represent the completed implementation. Generic file/working-file input remains.

Status: IN PROGRESS. Start: `0e991f77`; stay on `feat/mcp-app-bridge` in MCP-Review.
Do not start bundle 11 or use real user-library deletion for development.

The desktop page deletion path was characterized with actual library data, memory,
run artifacts, no-op/missing memory and existing transaction crash tests. Nine
baseline cases passed; a shared-original case failed because deleting one page
also removed the file still referenced by its sibling. The shared native page
preparation/staging preserves sibling-owned paths. All ten cases then passed.
Evidence: `.tmp/mcp-page-deletion-native-{baseline,fixed}.log`.

Planned public slice: preview/delete/inspect/list/Undo/Redo/protected-discard one
page. Retain the original chapter tree using the existing encrypted chunk codec;
remove only the native-selected page assets and reconcile memory using existing
policies. Restore exact removed bytes, metadata, memory presence and directories
through the existing transaction journal. Unselected chapter data is never silently
replaced. Later edits, occupied paths, linked workspaces, open editor, changed grant,
expiry and changed source must reject publication. No path/record/callback is a
public input. No model, network, source-history rewrite or automatic execution.

Native binary restoration joins the current replace-file journal rather than using
a second transaction engine. Original JSON serialization, hash checks, rollback,
startup recovery and ownership remain. Dedicated byte/crash tests are pending.

No public page-deletion tools are registered yet. Complete integration, strict output
contracts, focused safety/recovery/HTTP tests, unchanged inherited coverage floors,
all 26 repository gates and dedicated isolated Electron verification remain.
User app/artwork/library/auth/models/Tailscale/OS settings remain untouched. Live
client/model acceptance stays deferred. Commit small units and record exact status.
