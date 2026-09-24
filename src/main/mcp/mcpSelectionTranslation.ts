import type { McpContextSnapshot } from "../application/mcpContextEditPolicy";
import type { McpOperationContext } from "../application/mcpOperationService";
import type {
  McpSelectionTranslation,
  McpSelectionAnalysisItem,
} from "../../shared/mcpSelectionAnalysis";
import type { TranslationOptions } from "../appSettings";
import type { TranslationBlock } from "../../shared/textTypes";
import { McpBlockTranslationService } from "../application/mcpBlockTranslationService";
import { requireBatchPage } from "../application/mcpPageBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter } from "../library";
import { translateMcpBlock } from "./mcpBlockTranslationAdapter";
import { prepareMcpBlockTranslationOptions } from "./mcpBlockTranslationOptions";

type Runtime = Parameters<typeof translateMcpBlock>[3];
type Target = McpSelectionTranslation["pages"][number];
export async function analyzeMcpSelectionTranslation(
  saved: McpContextSnapshot,
  input: McpSelectionTranslation,
  base: TranslationOptions,
  context: McpOperationContext,
  runtime?: Runtime,
) {
  const options = selectionOptions(input, base);
  const service = new McpBlockTranslationService({
    openChapter,
    translate: (target, operation) =>
      translateMcpBlock(target, options, operation, runtime),
  });
  const pages = selectedPages(saved, input);
  const items: McpSelectionAnalysisItem[] = [];
  const total = pages.reduce((n, page) => n + page.blocks.length, 0);
  for (const { target, blocks } of pages) {
    for (const block of blocks) {
      const item = await translateItem(
        block,
        target,
        input,
        service,
        context,
        items.length,
      );
      items.push(item);
      context.progress({
        phase: "selected_translation",
        completed: items.length,
        total,
      });
    }
  }
  return items;
}
function selectionOptions(
  input: McpSelectionTranslation,
  base: TranslationOptions,
) {
  if (base.modelProvider !== input.expectedEngine)
    throw new McpEditError(
      "revision_conflict",
      "Configured translation engine differs from expectedEngine. No fallback was started.",
    );
  if (
    base.modelProvider === "gemma"
      ? !input.allowAssetDownloads
      : !input.allowExternal
  )
    throw new McpEditError(
      "access_denied",
      "Explicit local asset permission or external text request permission is required for this engine.",
    );
  return prepareMcpBlockTranslationOptions({
    ...base,
    ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
    ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
  }).options;
}
function selectedPages(
  saved: McpContextSnapshot,
  input: McpSelectionTranslation,
) {
  return input.pages.map((target) => {
    const page = requireBatchPage(saved.chapter, {
      ...target,
      edits: target.blockIds.map((blockId) => ({ blockId })),
    });
    return {
      target,
      blocks: target.blockIds.map((id) => {
        const block = page.blocks.find((block) => block.id === id);
        if (!block)
          throw new McpEditError(
            "not_found",
            "Selected translation block is missing.",
          );
        if (
          block.sourceText.length > 20000 ||
          block.translatedText.length > 20000
        )
          throw new McpEditError(
            "invalid_edit",
            "Selected text exceeds its review limit.",
          );
        return block;
      }),
    };
  });
}
async function translateItem(
  block: TranslationBlock,
  target: Target,
  input: McpSelectionTranslation,
  service: McpBlockTranslationService,
  context: McpOperationContext,
  index: number,
): Promise<McpSelectionAnalysisItem> {
  context.assertAuthorized();
  const item: McpSelectionAnalysisItem = {
    itemId: `item-${index + 1}`,
    pageId: target.pageId,
    revision: target.revision,
    blockId: block.id,
    regionId: null,
    excludedReason: translationExclusion(
      block,
      input.preserveExistingTranslations,
    ),
    engine: null,
    ocr: null,
    translation: null,
    overlaps: [],
  };
  if (!item.excludedReason) {
    const proposal = await service.run(
      {
        chapterId: input.chapterId,
        pageId: target.pageId,
        revision: target.revision,
        blockId: block.id,
        contextMode: input.contextMode,
        requestId: input.requestId,
      },
      context,
    );
    if (proposal.status !== "proposed")
      throw new McpEditError(
        "revision_conflict",
        "Selected source changed before translation.",
      );
    item.engine = proposal.engine;
    item.translation = proposal.blockTranslation;
  }
  return item;
}
function translationExclusion(block: TranslationBlock, preserve: boolean) {
  if (block.generatedLettering) return "generated_lettering";
  if (!block.sourceText.trim()) return "no_source_text";
  return preserve && block.translatedText.trim()
    ? "existing_translation_preserved"
    : null;
}
