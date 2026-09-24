import { McpContextReferenceService } from "../application/mcpContextReferenceService";
import { McpContextMigrationPreviewService } from "../application/mcpContextMigrationPreviewService";
import { readWorkContextReferences } from "../library/libraryContextEditingFacade";
import {
  McpContextReferencesSchema,
  type McpContextReferences,
} from "../../shared/mcpContextReferences";
import {
  McpContextMigrationPreviewSchema,
  type McpContextMigrationPreview,
} from "../../shared/mcpContextMigration";
import { createMcpBatchTool } from "./mcpBatchTool";

export function createMcpContextReferenceTools() {
  const service = new McpContextReferenceService(readWorkContextReferences);
  const migration = new McpContextMigrationPreviewService(
    readWorkContextReferences,
  );
  return [
    createMcpBatchTool({
      name: "carrot_get_context_references",
      description:
        "Inspect saved speaker/glossary links across every chapter and memory of the anchor chapter's work. Lists active, disabled, missing or ambiguous references, duplicate links and orphaned memories. Paginate with the returned snapshot; counts cover the entire work. Does not mutate, merge, research, translate or certify memory freshness. No names, story text, images or local paths are returned.",
      schema: McpContextReferencesSchema,
      scopes: ["carrot.read"],
      write: false,
      execute: (args, _owner, guard) =>
        service.inspect(args as McpContextReferences, guard),
    }),
    createMcpBatchTool({
      name: "carrot_preview_context_migration",
      description:
        "Preview an explicit glossary/character merge, deletion or catalog replacement across the entire saved work. First read an unfiltered carrot_get_context_references snapshot. Manual and legacy entries are protected by default; removed referenced IDs require an explicit destination or unlink instruction. Reports entry differences and every affected block/memory link, including orphaned memories. Paginate entries or references with the returned plan fingerprint. This is read-only and non-executable: no context, dialogue, memory, image or history is saved and no model/research runs. Apply/Undo/Redo are not part of this preview.",
      schema: McpContextMigrationPreviewSchema,
      scopes: ["carrot.read"],
      write: false,
      execute: (args, _owner, guard) =>
        migration.preview(args as McpContextMigrationPreview, guard),
    }),
  ];
}
