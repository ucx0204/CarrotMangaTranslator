import { createMcpBatchTool } from "./mcpBatchTool";
import { McpPageDeletionApplication } from "./mcpPageDeletionApplication";
import { McpPageDeletionRepository } from "./mcpPageDeletionRepository";
import type { ChapterDeletionEditor } from "./mcpChapterDeletionApplication";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { McpRetentionCatalog } from "./mcpRetentionCatalog";
import type { McpPreferences } from "../../shared/mcpDesktopTypes";
import {
  McpPageDeletionTargetSchema,
  McpPageDeletionApplySchema,
} from "../../shared/mcpPageDeletion";
import { McpChapterDeletionRecoverySchema } from "../../shared/mcpChapterDeletion";
import {
  McpRetainedGetSchema,
  McpRetentionListSchema,
  McpRetainedDiscardSchema,
} from "../../shared/mcpRetention";

type Run = (
  guard: () => void,
  action: (guard: () => void) => Promise<unknown>,
) => Promise<unknown>;

/** Uses the organization session's existing lifetime and approved connection. */
export function createMcpPageDeletionTools(
  storage: McpRetentionStorage,
  catalog: McpRetentionCatalog,
  preferences: McpPreferences,
  editing: ChapterDeletionEditor | undefined,
  run: Run,
) {
  const service = new McpPageDeletionApplication(
    new McpPageDeletionRepository(storage),
    editing,
  );
  const tools = [
    createMcpBatchTool({
      name: "carrot_preview_page_deletion",
      schema: McpPageDeletionTargetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Review deletion of exactly one saved page and its native-owned original/processed/mask/run files. Returns names, removed totals and memory reconciliation counts, not artwork, private text, paths or raw records. Reads/hashes the entire bounded chapter for exact recovery: at most 50 pages, 2000 entries, 128 MiB/file, 256 MiB total. No save/model/network. Apply separately; target chapter must be closed and unlinked.",
      execute: (args, _owner, guard) =>
        run(guard, (check) =>
          service.preview(McpPageDeletionTargetSchema.parse(args), check),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_get_page_deletion",
      schema: McpRetainedGetSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "Inspect an owned retained page deletion and compare the whole surviving chapter/work with the saved state for advisory Undo/Redo. Verifies encrypted original bytes; no restoration or image transfer. Later edits, moved/missing chapter, linked workspace, expiry or occupied locations reject exact recovery. No automatic retry.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          service.inspect(owner, McpRetainedGetSchema.parse(args).id, check),
        ),
    }),
    createMcpBatchTool({
      name: "carrot_list_page_deletions",
      schema: McpRetentionListSchema,
      scopes: ["carrot.read"],
      write: false,
      description:
        "List this approved connection's retained page deletion IDs after restart. Metadata only; use the returned catalog snapshot for pagination. Same-profile/owner seven-day shared 256-record/1-GiB history, not permanent trash. Inspect before recovery.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          catalog.list(
            owner,
            "page-deletion",
            McpRetentionListSchema.parse(args),
            check,
          ),
        ),
    }),
  ];
  if (preferences.allowEditing && preferences.allowProcessing)
    tools.push(...mutations(service, run));
  return tools;
}
function mutations(service: McpPageDeletionApplication, run: Run) {
  const scopes = ["carrot.read", "carrot.edit", "carrot.process"];
  return [
    createMcpBatchTool({
      name: "carrot_delete_page",
      schema: McpPageDeletionApplySchema,
      scopes,
      write: true,
      description:
        "Delete ONLY the reviewed page using its work/chapter/page IDs, snapshot, new requestId and confirm=delete-page-with-seven-day-recovery. Chapter must be closed/unlinked. Verified encrypted originals, page/file removal, native memory reconciliation and receipt commit together. Sibling source files and external originals remain. Last-page deletion leaves an empty chapter. Seven-day recovery may then be permanently pruned. No OCR/translation. Historical replay never deletes a restored page again.",
      execute: (args, owner, guard) =>
        run(guard, (check) =>
          service.apply(owner, McpPageDeletionApplySchema.parse(args), check),
        ),
    }),
    ...(["undo", "redo"] as const).map((direction) =>
      createMcpBatchTool({
        name: `carrot_${direction}_page_deletion`,
        schema: McpChapterDeletionRecoverySchema,
        scopes,
        write: true,
        description: `${direction.toUpperCase()} an owned page deletion with a current inspection snapshot, new requestId and confirm=true. Undo restores exact removed files, page metadata, prior memory bytes/presence and work timestamp; Redo repeats only the recorded removal. Closed/unlinked chapter required. Later saved edits reject instead of being overwritten. Same profile/owner, seven days, at most 32 recovery actions. No model execution or auto-resume of old jobs.`,
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
      name: "carrot_discard_page_deletion",
      schema: McpRetainedDiscardSchema,
      scopes,
      write: true,
      description:
        "Discard an owned page recovery record ONLY after exact verified restoration, with confirm=true. Restored page and external originals remain. A still-deleted page's backup cannot be purged early with this or generic discard; the acknowledged seven-day expiry still applies.",
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
