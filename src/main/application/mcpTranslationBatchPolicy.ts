import type { BatchPage, BatchPlan, BatchPolicy } from "./mcpPageBatchTypes";
import type { McpTranslationPatch } from "../../shared/mcpEditingTypes";
import type { ChapterSnapshot } from "../../shared/libraryTypes";
import {
  mcpBatchMembership,
  requireBatchPage,
  validateBatchTargets,
} from "./mcpPageBatchPolicy";
import {
  McpTranslationBatchPreviewSchema,
  type McpTranslationBatchPreview,
} from "../../shared/mcpTranslationBatch";
import type { McpContextSnapshot } from "./mcpContextEditPolicy";
import { McpEditError } from "./mcpEditPolicy";

type BatchTextChange = {
  pageId: string;
  blockId: string;
  sourceText: string;
  previousText: string;
  proposedText: string;
  reason: string;
  excludedReason: string | null;
  changed: boolean;
};
type BatchTextPage = BatchPage<BatchTextChange>;
export type BatchTextPlan = BatchPlan<BatchTextChange>;
/** Never accepts whole blocks or a replacement chapter from the AI. */
export function planMcpTranslationBatch(
  saved: McpContextSnapshot,
  input: McpTranslationBatchPreview,
): BatchTextPlan {
  const request = McpTranslationBatchPreviewSchema.parse(input);
  const chapter = saved.chapter;
  validateBatchTargets(saved, request);
  const pages = request.pages.map((target) =>
    planPage(chapter, target, request.allowEmpty),
  );
  // Storage runs in current chapter reading order, never in a later search result's order.
  pages.sort(
    (a, b) =>
      chapter.pages.findIndex((page) => page.id === a.pageId) -
      chapter.pages.findIndex((page) => page.id === b.pageId),
  );
  return {
    workId: saved.workId,
    membership: mcpBatchMembership(chapter),
    pages,
  };
}
function planPage(
  chapter: ChapterSnapshot,
  target: McpTranslationBatchPreview["pages"][number],
  allowEmpty: boolean,
): BatchTextPage {
  const page = requireBatchPage(chapter, target);
  const blocks = new Map(page.blocks.map((block) => [block.id, block]));
  const changes = target.edits.map((edit): BatchTextChange => {
    const block = blocks.get(edit.blockId);
    if (!block)
      throw new McpEditError(
        "not_found",
        "A selected block is absent from its page.",
      );
    if (block.sourceText.length > 20000 || block.translatedText.length > 20000)
      throw new McpEditError(
        "invalid_edit",
        "Stored text exceeds the review limit.",
      );
    if (
      !allowEmpty &&
      block.translatedText.trim() &&
      !edit.translatedText.trim() &&
      !block.generatedLettering
    )
      throw new McpEditError(
        "invalid_edit",
        "Clearing existing text requires explicit allowEmpty; no changes were saved.",
      );
    return {
      pageId: page.id,
      blockId: block.id,
      sourceText: block.sourceText,
      previousText: block.translatedText,
      proposedText: edit.translatedText,
      reason: edit.reason,
      excludedReason: block.generatedLettering ? "generated_lettering" : null,
      changed:
        !block.generatedLettering &&
        block.translatedText !== edit.translatedText,
    };
  });
  const changedBlocks = changes.filter((change) => change.changed).length;
  return {
    pageId: page.id,
    expectedRevision: target.revision,
    changes,
    changedBlocks,
    state: changedBlocks
      ? "pending"
      : changes.every((change) => change.excludedReason)
        ? "excluded"
        : "unchanged",
    result: "not_started",
    errorCode: null,
  };
}

/** Calculation and request mapping differ; lifecycle, cancellation and receipts are shared. */
export const translationBatchPolicy: BatchPolicy<
  McpTranslationBatchPreview,
  BatchTextChange,
  McpTranslationPatch,
  BatchTextChange
> = {
  parse: (value) => McpTranslationBatchPreviewSchema.parse(value),
  plan: planMcpTranslationBatch,
  request: (page, input, direction) => ({
    chapterId: input.chapterId,
    pageId: page.pageId,
    revision: page.expectedRevision as McpTranslationPatch["revision"],
    edits: page.changes
      .filter((change) => change.changed)
      .map((change) => ({
        blockId: change.blockId,
        translatedText:
          direction === "undo" ? change.previousText : change.proposedText,
      })),
  }),
  project: (change) => structuredClone(change),
  inspectTool: "carrot_get_translation_batch",
  exclusionWarning: "generated_lettering_excluded",
};
