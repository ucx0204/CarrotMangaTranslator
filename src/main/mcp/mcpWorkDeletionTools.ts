import type { z } from "zod/v4";
import { createMcpBatchTool } from "./mcpBatchTool";
import type { createMcpChapterDeletionTools } from "./mcpChapterDeletionTools";
import { McpWorkDeletionApplication } from "./mcpWorkDeletionApplication";
import { McpWorkDeletionRepository } from "./mcpWorkDeletionRepository";
import {
  McpWorkDeletionTargetSchema,
  McpWorkDeletionApplySchema,
} from "../../shared/mcpWorkDeletion";
import { McpChapterDeletionRecoverySchema } from "../../shared/mcpChapterDeletion";
import {
  McpRetainedGetSchema,
  McpRetainedDiscardSchema,
  McpRetentionListSchema,
} from "../../shared/mcpRetention";

type Execute = (
  args: unknown,
  owner: string,
  guard: () => void,
) => Promise<unknown>;
type BuildTool = (
  name: string,
  schema: z.ZodType,
  write: boolean,
  description: string,
  execute: Execute,
) => ReturnType<typeof createMcpBatchTool>;
/** Reuses the actual organization lifetime, permissions and trusted editor probes. */
export function createMcpWorkDeletionTools(
  ...[storage, catalog, preferences, editing, run]: Parameters<
    typeof createMcpChapterDeletionTools
  >
) {
  const service = new McpWorkDeletionApplication(
    new McpWorkDeletionRepository(storage),
    editing,
  );
  const tool: BuildTool = (
    name: string,
    schema: z.ZodType,
    write: boolean,
    description: string,
    execute: Execute,
  ) =>
    createMcpBatchTool({
      name,
      schema,
      write,
      description,
      scopes: write
        ? ["carrot.read", "carrot.edit", "carrot.process"]
        : ["carrot.read"],
      execute: (args, owner, guard) =>
        run(guard, (check) => execute(args, owner, check)),
    });
  const reads = [
    tool(
      "carrot_preview_work_deletion",
      McpWorkDeletionTargetSchema,
      false,
      "Review removal of ONE entire work including all its library originals, chapters, context and run files. Returns names, bounded chapter/file totals and snapshot; no paths, source text or image transfer. No mutation or model/network calls. Up to 10 chapters, 50 total pages, 2000 filesystem entries, 128 MiB/file, 256 MiB total. Linked workspaces must first be explicitly detached. Apply separately with seven-day recovery acknowledgement; this is not permanent trash.",
      (args, _owner, guard) =>
        service.preview(McpWorkDeletionTargetSchema.parse(args).workId, guard),
    ),
    tool(
      "carrot_get_work_deletion",
      McpRetainedGetSchema,
      false,
      "Inspect this approved connection's work removal record and verify archived chapter identities/bytes. Advisory exact Undo/Redo availability against the current library index and directory; actual mutation rechecks all chapters closed/unlinked. Later library changes or occupied original paths prevent forced restoration. No execution or transfer of originals.",
      (args, owner, guard) =>
        service.inspect(owner, McpRetainedGetSchema.parse(args).id, guard),
    ),
    tool(
      "carrot_list_work_deletions",
      McpRetentionListSchema,
      false,
      "List owned work removal recovery IDs after restart. Metadata only; catalog snapshot required for pagination. Existing same-profile/owner seven-day, shared 256-record/1-GiB retention. Expiry may permanently prune recovery, not a permanent trash bin.",
      (args, owner, guard) =>
        catalog.list(
          owner,
          "work-deletion",
          McpRetentionListSchema.parse(args),
          guard,
        ),
    ),
  ];
  if (!preferences.allowEditing || !preferences.allowProcessing) return reads;
  return [...reads, ...workDeletionMutations(service, tool)];
}
function workDeletionMutations(
  service: McpWorkDeletionApplication,
  tool: BuildTool,
) {
  return [
    tool(
      "carrot_delete_work",
      McpWorkDeletionApplySchema,
      true,
      "Delete exactly the work reviewed with snapshot, new requestId and confirm=delete-work-with-seven-day-recovery. ALL chapters must be closed and unlinked. Verified OS/profile-encrypted backup, native directory retirement, library index and recovery publish atomically. No external originals/mirror folders or models are touched. Recovery expires after seven days and may then be permanently pruned; replay after Undo is historical, not another deletion.",
      (args, owner, guard) =>
        service.apply(owner, McpWorkDeletionApplySchema.parse(args), guard),
    ),
    ...(["undo", "redo"] as const).map((direction) =>
      tool(
        `carrot_${direction}_work_deletion`,
        McpChapterDeletionRecoverySchema,
        true,
        `${direction.toUpperCase()} the owned work removal using the current inspection snapshot, new requestId and confirm=true. Exact directory bytes and original library order, without overwriting later data or occupied paths. All affected chapters closed/unlinked; seven-day expiry and 32 recovery actions. No network/model calls.`,
        (args, owner, guard) =>
          service.recover(
            owner,
            McpChapterDeletionRecoverySchema.parse(args),
            direction,
            guard,
          ),
      ),
    ),
    tool(
      "carrot_discard_work_deletion",
      McpRetainedDiscardSchema,
      true,
      "Discard an owned work recovery record only AFTER exact restoration is verified, with confirm=true. Does not delete the restored work or originals. Unrestored recovery cannot be purged early through this or generic discard; the acknowledged seven-day expiry still applies.",
      (args, owner, guard) =>
        service.discard(owner, McpRetainedDiscardSchema.parse(args).id, guard),
    ),
  ];
}
