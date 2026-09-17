import { translationBatchPolicy } from "../application/mcpTranslationBatchPolicy";
import {
  McpChapterTextSearchSchema,
  McpTranslationBatchPreviewSchema,
  McpTranslationBatchGetSchema,
  McpTranslationBatchActionSchema,
} from "../../shared/mcpTranslationBatch";
import { searchMcpChapterText } from "../application/mcpChapterTextSearch";
import { McpPageBatchService } from "../application/mcpPageBatchService";
import type { McpTool } from "./mcpReadTools";
import { createMcpBatchTool } from "./mcpBatchTool";

type Ports = ReturnType<
  typeof import("./mcpTranslationBatchAdapter").createMcpTranslationBatchPorts
>;
const editScopes = ["carrot.read", "carrot.edit", "carrot.process"];
export function createMcpTranslationBatchTools(
  ports: Ports,
  allowEditing: boolean,
  lifetime?: AbortSignal,
): McpTool[] {
  const service = new McpPageBatchService(
    ports,
    translationBatchPolicy,
    Date.now,
    lifetime,
  );
  const tools = [
    createMcpBatchTool({
      name: "carrot_search_chapter_text",
      schema: McpChapterTextSearchSchema,
      description:
        "Search or explicitly browse ONE chapter's saved source/translation text. Infer candidates from the user's complaint; do not ask users for block IDs. Literal case-sensitive contains/exact, no regex or model. Optional format conditions match stored or app-effective style values with AND semantics; font sizes are nominal, not measured rendered sizes. Use browse for style-only searches. Missing stored properties do not match. Read format views and preserve manual size intent unless the user requested changing it. Read-only snippets include UTF-16 match offsets, nearby dialogue, revision and generated-lettering exclusions. Use the first snapshot for every subsequent offset with identical criteria; changed data requires restarting the search. Snippets are marked when truncated: read full blocks before editing. Search matches are candidates, not permission for blanket replacement.",
      scopes: ["carrot.read"],
      write: false,
      execute: async (args, _owner, guard) => {
        const request = McpChapterTextSearchSchema.parse(args);
        const saved = await ports.read(request.chapterId);
        guard();
        return searchMcpChapterText(saved, request);
      },
    }),
  ];
  if (!allowEditing) return tools;
  tools.push(
    createMcpBatchTool({
      name: "carrot_preview_translation_batch",
      schema: McpTranslationBatchPreviewSchema,
      description:
        "Prepare explicit per-block translation corrections across at most 50 pages/1000 blocks in ONE chapter. The AI reads original/dialogue/context and writes each correction; no automatic replacement or model call. Read page revisions and work-context revision first. Only translatedText can change; generated lettering is excluded with reasons. Emptying existing text needs allowEmpty. No page writes. Inspect paginated changes, then apply within the user's requested scope without demanding repeated human approval. Session-only plans/history expire after 30 minutes or restart.",
      scopes: editScopes,
      write: false,
      execute: (args, owner, guard) => service.preview(owner, args, guard),
    }),
    createMcpBatchTool({
      name: "carrot_get_translation_batch",
      schema: McpTranslationBatchGetSchema,
      description:
        "Inspect this connection's translation batch: before/after changes, excluded items, per-page outcomes, latest action status and current conflict warnings. Poll every few seconds after accepted actions. A receipt is NOT completion. Partial means inspect saved/failed/unprocessed pages; never replay all pages with fresh revisions. No attachment, mutation, model or rendering. Explicitly render changed pages to verify visual quality; stored text success is not visual verification.",
      scopes: ["carrot.read"],
      write: false,
      execute: (args, owner, guard) => service.inspect(owner, args, guard),
    }),
  );
  for (const direction of ["apply", "undo", "redo"] as const)
    tools.push(
      createMcpBatchTool({
        name: `carrot_${direction}_translation_batch`,
        schema: McpTranslationBatchActionSchema,
        description: `${direction.toUpperCase()} an owned translation batch with a NEW action requestId. Returns accepted metadata; poll carrot_get_translation_batch. Uses the fixed plan, existing page handoff and atomic translation-only save, sequentially with no model. Stops on first conflict/failure/cancellation; committed pages remain recorded. Unprocessed pages need a fresh preview, never forced revision substitution. Undo/redo affect only eligible committed pages, refusing subsequent user edits; no automatic merge. Retry IDENTICAL action IDs only for lost replies; historical receipts never reapply. Verify actual rendering afterwards. No files or automatic formatting.`,
        scopes: editScopes,
        write: true,
        background: true,
        execute: async (args, owner, guard) =>
          service.start(owner, args, direction, guard),
      }),
    );
  tools.push(
    createMcpBatchTool({
      name: "carrot_cancel_translation_batch",
      schema: McpTranslationBatchActionSchema,
      description:
        "Cancel ONLY the batch action requestId currently shown by get_translation_batch. Wait for terminal status before any undo or next action. An older cancellation cannot cancel a newer action. Cancellation stops future page commits and never rolls back already saved pages. No files, models or rendering.",
      scopes: editScopes,
      write: true,
      execute: async (args, owner, guard) => service.cancel(owner, args, guard),
    }),
  );
  return tools;
}
