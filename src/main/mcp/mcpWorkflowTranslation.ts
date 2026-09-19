import { randomUUID } from "node:crypto";
import type { MangaPage } from "../../shared/libraryTypes";
import type { McpWorkflowStage } from "../../shared/mcpWorkflow";
import { resolvePageBlocksForReading } from "../../shared/blockReadingOrder";
import { mcpSelectionAnalysisOutputs } from "../../shared/mcpSelectionAnalysis";
import { mcpSelectionBatchOutputs } from "../../shared/mcpSelectionEditing";
import type {
  McpWorkflowRecord,
  McpWorkflowStep,
  McpWorkflowOutcome,
} from "../application/mcpWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpWorkflowCalls } from "./mcpWorkflowCalls";
import { readWorkflowPage } from "./mcpWorkflowEvidence";

type TranslationStage = Extract<McpWorkflowStage, { kind: "translate" }>;
export function workflowTranslationBlocks(
  page: MangaPage,
  stage: TranslationStage,
) {
  const blocks = resolvePageBlocksForReading(page).filter(
    (block) =>
      !block.generatedLettering &&
      block.sourceText.trim() &&
      (!stage.preserveExistingTranslations || !block.translatedText.trim()),
  );
  if (blocks.length > 100)
    throw new McpEditError(
      "invalid_edit",
      "A workflow translation page supports at most 100 eligible blocks. Use explicit selection tools for larger pages.",
    );
  return blocks;
}
export async function translateWorkflowPage(
  record: McpWorkflowRecord,
  step: McpWorkflowStep,
  calls: McpWorkflowCalls,
  signal: AbortSignal,
  onJob: (id: string) => Promise<void>,
  guard: () => void,
): Promise<McpWorkflowOutcome> {
  const stage = record.input.stages[step.stageIndex];
  if (stage.kind !== "translate" || !step.attemptId)
    throw new Error("Expected an admitted translation step.");
  if (!calls.waitSelection)
    throw new McpEditError(
      "invalid_edit",
      "Native selection completion is unavailable.",
    );
  const target = record.pages[step.pageIndex];
  const { page } = await readWorkflowPage(target, guard);
  const blocks = workflowTranslationBlocks(page, stage);
  if (!blocks.length)
    return {
      revision: target.revision,
      outcome: "existing_translations_or_empty_sources_preserved",
    };
  const { kind: _kind, ...options } = stage;
  const analysis = await calls.job(
    "carrot_run_selection_translation",
    {
      ...options,
      chapterId: target.chapterId,
      contextRevision: target.contextRevision,
      requestId: randomUUID(),
      pages: [
        {
          pageId: target.pageId,
          revision: target.revision,
          blockIds: blocks.map((block) => block.id),
        },
      ],
    },
    signal,
    onJob,
  );
  const analysisId = analysis.selectionAnalysis?.analysisId;
  if (!analysisId) throw new Error("Selection analysis reference is missing.");
  const edits = await collectTranslationEdits(calls, analysisId);
  if (!edits.length)
    return { revision: target.revision, outcome: "no_translation_changes" };
  const preview = mcpSelectionBatchOutputs.carrot_preview_selection_batch.parse(
    await calls.call("carrot_preview_selection_batch", {
      chapterId: target.chapterId,
      contextRevision: target.contextRevision,
      requestId: randomUUID(),
      reason: record.input.reason,
      command: { kind: "analysis", analysisId },
      pages: [{ pageId: target.pageId, revision: target.revision, edits }],
    }),
  );
  const completed = await calls.applySelection(
    preview.batchId,
    step.attemptId,
    signal,
  );
  const result = completed.pages.find((page) => page.pageId === target.pageId);
  if (
    completed.status !== "completed" ||
    !result ||
    !["applied", "unchanged", "excluded"].includes(result.state)
  )
    throw new McpEditError(
      "invalid_edit",
      "Selection application did not complete. Inspect durable page changes before retrying.",
    );
  return { revision: result.expectedRevision };
}
async function collectTranslationEdits(
  calls: McpWorkflowCalls,
  analysisId: string,
) {
  const edits: { kind: "translation"; itemId: string; reason: string }[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const view =
      mcpSelectionAnalysisOutputs.carrot_get_selection_analysis.parse(
        await calls.call("carrot_get_selection_analysis", {
          analysisId,
          offset,
          limit: 10,
        }),
      );
    for (const item of view.items)
      if (!item.excludedReason && item.translation)
        edits.push({
          kind: "translation",
          itemId: item.itemId,
          reason: "Explicit workflow translation stage",
        });
    offset = view.nextOffset;
  }
  return edits;
}
