import { createMcpBatchTool } from "./mcpBatchTool";
import {
  McpChapterDeletionApplication,
  type ChapterDeletionEditor,
} from "./mcpChapterDeletionApplication";
import { McpChapterDeletionRepository } from "./mcpChapterDeletionRepository";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpRetentionCatalog } from "./mcpRetentionCatalog";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import {
  McpChapterDeletionTargetSchema,
  McpChapterDeletionApplySchema,
  McpChapterDeletionRecoverySchema,
} from "../../shared/mcpChapterDeletion";
import {
  McpRetainedGetSchema,
  McpRetentionListSchema,
  McpRetainedDiscardSchema,
} from "../../shared/mcpRetention";

type Run = (
  guard: () => void,
  action: (guard: () => void) => Promise<unknown>,
) => Promise<unknown>;

/** Shares the existing organization session's stop/close tracking, not a second queue. */
export function createMcpChapterDeletionTools(
  storage: McpRetentionStorage,
  catalog: McpRetentionCatalog,
  preferences: McpPreferences,
  editing: ChapterDeletionEditor | undefined,
  run: Run,
) {
  const service = new McpChapterDeletionApplication(
    new McpChapterDeletionRepository(storage),
    editing,
  );
  const tools = [
    createMcpBatchTool({
      name: "carrot_preview_chapter_deletion",
      schema: McpChapterDeletionTargetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Review removal of one chapter INCLUDING library originals, memory and run files. Reads/hashes local source files but returns only names/totals and a bound snapshot; no paths, text or images. No change. At most 50 pages, 2000 entries, 128 MiB per file, 256 MiB total. Apply separately with explicit seven-day recovery acknowledgement. Work/page removal and moves are not included.",
      execute: (args, _owner, guard) =>
        run(guard, (check) =>
          service.preview(McpChapterDeletionTargetSchema.parse(args), check),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_get_chapter_deletion",
      schema: McpRetainedGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect an owned chapter removal record, verify encrypted recovery bytes and compare work/directory state for advisory Undo/Redo. No reexecution or image transfer. The target must be closed at actual mutation time. Missing works or occupied original locations are never recreated or overwritten.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          service.inspect(owner, McpRetainedGetSchema.parse(args).id, check),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_list_chapter_deletions",
      schema: McpRetentionListSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "List this approved connection's retained chapter removal IDs after restart. Metadata only; use the catalog snapshot for pagination and inspect before recovery. Same profile/owner, seven days, shared 256-record/1-GiB catalog; not a permanent trash archive.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          catalog.list(
            owner,
            "chapter-deletion",
            McpRetentionListSchema.parse(args),
            check,
          ),
        ),
    }),
  ];
  if (preferences.allowEditing && preferences.allowProcessing)
    tools.push(...mutationTools(service, run));
  return tools;
}
function mutationTools(service: McpChapterDeletionApplication, run: Run) {
  const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
  return [
    createMcpBatchTool({
      name: "carrot_delete_chapter",
      schema: McpChapterDeletionApplySchema,
      scopes,
      write: true,
      description:
        "Remove exactly the reviewed chapter with snapshot, new requestId and confirm=delete-chapter-with-seven-day-recovery. Target must be closed in the desktop editor. Verified profile-encrypted recovery copy, removal and catalog commit atomically. Recovery expires after seven days and may then be permanently pruned. External source files remain. No models/network. Historical replay never removes a restored chapter again.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          service.apply(
            owner,
            McpChapterDeletionApplySchema.parse(args),
            check,
          ),
        ),
    }),
    ...(["undo", "redo"] as const).map((direction) =>
      createMcpBatchTool({
        name: `carrot_${direction}_chapter_deletion`,
        schema: McpChapterDeletionRecoverySchema,
        scopes,
        write: true,
        description: `${direction.toUpperCase()} an owned chapter removal using the current inspection snapshot, new requestId and confirm=true. Undo restores exact original directory bytes and work metadata; Redo removes it again. Target must be closed. Later edits, missing work or occupied location reject recovery. No paths, model calls or forced overwrite. Same profile/owner, seven days, at most 32 actions.`,
        execute: (args, owner, guard) =>
          run(guard, (check) =>
            service.recover(
              owner,
              McpChapterDeletionRecoverySchema.parse(args),
              direction,
              check,
            ),
          ),
      }),
    ),
    createMcpBatchTool({
      name: "carrot_discard_chapter_deletion",
      schema: McpRetainedDiscardSchema,
      scopes,
      write: true,
      description:
        "Discard an owned recovery record only AFTER verified restoration, with confirm=true. Restored chapter and external originals remain. A still-removed chapter's recovery cannot be purged early through this or generic discard. The explicitly acknowledged seven-day expiration still applies.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          service.discard(
            owner,
            McpRetainedDiscardSchema.parse(args).id,
            check,
          ),
        ),
    }),
  ];
}
