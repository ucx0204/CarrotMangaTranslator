import type { z } from "zod/v4";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { createMcpChapterDeletionTools } from "./mcpChapterDeletionTools";
import { McpChapterMoveApplication } from "./mcpChapterMoveApplication";
import { McpChapterMoveRepository } from "./mcpChapterMoveRepository";
import {
  McpChapterMovePreviewSchema,
  McpChapterMoveApplySchema,
} from "../../shared/mcpChapterMove";
import { McpChapterDeletionRecoverySchema } from "../../shared/mcpChapterDeletion";
import {
  McpRetainedGetSchema,
  McpRetentionListSchema,
} from "../../shared/mcpRetention";

type Definition = {
  name: string;
  schema: z.ZodType;
  write: boolean;
  description: string;
  execute: (
    args: unknown,
    owner: string,
    guard: () => void,
  ) => Promise<unknown>;
};
/** Reuses organization lifetime tracking, existing profile storage and trusted editor probes. */
export function createMcpChapterMoveTools(
  ...[storage, catalog, preferences, editing, run]: Parameters<
    typeof createMcpChapterDeletionTools
  >
) {
  const service = new McpChapterMoveApplication(
    new McpChapterMoveRepository(storage),
    editing,
  );
  const definitions = movementDefinitions(service, catalog);
  return definitions
    .filter(
      (item) =>
        !item.write ||
        (preferences.allowEditing && preferences.allowProcessing),
    )
    .map((definition) =>
      createMcpBatchTool({
        ...definition,
        scopes: definition.write
          ? ["carrot.read", "carrot.edit", "carrot.process"]
          : ["carrot.read"],
        execute: (args, owner, guard) =>
          run(guard, (check) => definition.execute(args, owner, check)),
      }),
    );
}

function movementDefinitions(
  service: McpChapterMoveApplication,
  catalog: Parameters<typeof createMcpChapterDeletionTools>[1],
): Definition[] {
  return [
    {
      name: "carrot_preview_chapter_move",
      schema: McpChapterMovePreviewSchema,
      write: false,
      description:
        "Review moving one chapter between two existing works, optionally before a destination chapter. Returns resulting title/orders, reference conflicts and local-checkpoint invalidation, never image bytes or paths. No publication or network/model calls. Maps explicitly named glossary/character IDs; otherwise destination definitions must be identical. No catalog merge. Linked workspaces must first be detached in the app. At most 50 pages/2000 entries/256 MiB source; recovery uses existing seven-day quota.",
      execute: (args, _owner, guard) =>
        service.preview(McpChapterMovePreviewSchema.parse(args).intent, guard),
    },
    {
      name: "carrot_get_chapter_move",
      schema: McpRetainedGetSchema,
      write: false,
      description:
        "Inspect an owned movement record after restart, verify encrypted originals and compare both works/current location for advisory exact Undo/Redo. Does not move, restore or rerun work. Missing works, occupied paths, later context or content edits block recovery.",
      execute: (args, owner, guard) =>
        service.inspect(owner, McpRetainedGetSchema.parse(args).id, guard),
    },
    {
      name: "carrot_list_chapter_moves",
      schema: McpRetentionListSchema,
      write: false,
      description:
        "List only this approved connection's retained movement IDs, using the catalog snapshot for pagination. Same profile/owner and seven-day shared limits. The ordinary moved chapter does not expire. Explicit generic retained-record disposal removes the recovery copy, not ordinary library data.",
      execute: (args, owner, guard) =>
        catalog.list(
          owner,
          "chapter-move",
          McpRetentionListSchema.parse(args),
          guard,
        ),
    },
    {
      name: "carrot_move_chapter",
      schema: McpChapterMoveApplySchema,
      write: true,
      description:
        "Move exactly the reviewed closed, unlinked chapter with current snapshot, planFingerprint, new requestId and confirm=move-chapter-between-existing-works. Existing ID/assets and supported memory are preserved; destination context applies and local-only checkpoints are invalidated. Verified originals, both work orders, moved directory and encrypted recovery publish atomically. No extra model calls. Replayed requests return historical receipts, including after Undo.",
      execute: (args, owner, guard) =>
        service.apply(owner, McpChapterMoveApplySchema.parse(args), guard),
    },
    ...(["undo", "redo"] as const).map(
      (direction): Definition => ({
        name: `carrot_${direction}_chapter_move`,
        schema: McpChapterDeletionRecoverySchema,
        write: true,
        description: `${direction.toUpperCase()} a reviewed movement using current inspection snapshot, new requestId and confirm=true. Target must be closed/unlinked. Restores exact recorded directory content and both works, without overwriting later edits or recreating missing works. Same profile/owner, seven days, at most 32 recovery actions. No network/model execution.`,
        execute: (args, owner, guard) =>
          service.recover(
            owner,
            McpChapterDeletionRecoverySchema.parse(args),
            direction,
            guard,
          ),
      }),
    ),
  ];
}
