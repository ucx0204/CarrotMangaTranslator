import type { McpContextSnapshot } from "../application/mcpContextEditPolicy";
import type { McpOperationContext } from "../application/mcpOperationService";
import type { McpSelectionTranslation, McpSelectionAnalysisItem } from "../../shared/mcpSelectionAnalysis";
import type { TranslationOptions } from "../appSettings";
import { McpBlockTranslationService } from "../application/mcpBlockTranslationService";
import { requireBatchPage } from "../application/mcpPageBatchPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { openChapter } from "../library";
import { translateMcpBlock } from "./mcpBlockTranslationAdapter";
import { prepareMcpBlockTranslationOptions } from "./mcpBlockTranslationOptions";

export async function analyzeMcpSelectionTranslation(saved: McpContextSnapshot, input: McpSelectionTranslation, base: TranslationOptions, context: McpOperationContext, runtime?: Parameters<typeof translateMcpBlock>[3]) {
  if (base.modelProvider !== input.expectedEngine)
    throw new McpEditError("revision_conflict", "Configured translation engine differs from expectedEngine. No fallback was started.");
  if (base.modelProvider === "gemma" ? !input.allowAssetDownloads : !input.allowExternal)
    throw new McpEditError("access_denied", "Explicit local asset permission or external text request permission is required for this engine.");
  const { options } = prepareMcpBlockTranslationOptions({
    ...base,
    ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
    ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
  });
  const service = new McpBlockTranslationService({ openChapter, translate: (target, operation) => translateMcpBlock(target, options, operation, runtime) });
  const pages = input.pages.map((target) => {
    const page = requireBatchPage(saved.chapter, { ...target, edits: target.blockIds.map((blockId) => ({ blockId })) });
    return { target, blocks: target.blockIds.map((id) => {
      const block = page.blocks.find((block) => block.id === id);
      if (!block) throw new McpEditError("not_found", "Selected translation block is missing.");
      if (block.sourceText.length > 20000 || block.translatedText.length > 20000)
        throw new McpEditError("invalid_edit", "Selected text exceeds its review limit.");
      return block;
    }) };
  });
  const items: McpSelectionAnalysisItem[] = [];
  const total = pages.reduce((n, page) => n + page.blocks.length, 0);
  for (const { target, blocks } of pages) {
    for (const block of blocks) {
      context.assertAuthorized();
      const item: McpSelectionAnalysisItem = {
        itemId: `item-${items.length + 1}`, pageId: target.pageId, revision: target.revision,
        blockId: block.id, regionId: null,
        excludedReason: block.generatedLettering ? "generated_lettering" : !block.sourceText.trim() ? "no_source_text" : input.preserveExistingTranslations && block.translatedText.trim() ? "existing_translation_preserved" : null,
        engine: null, ocr: null, translation: null, overlaps: [],
      };
      if (!item.excludedReason) {
        const proposal = await service.run({ chapterId: input.chapterId, pageId: target.pageId, revision: target.revision, blockId: block.id, contextMode: input.contextMode, requestId: input.requestId }, context);
        if (proposal.status !== "proposed") throw new McpEditError("revision_conflict", "Selected source changed before translation.");
        item.engine = proposal.engine;
        item.translation = proposal.blockTranslation;
      }
      items.push(item);
      context.progress({ phase: "selected_translation", completed: items.length, total });
    }
  }
  return items;
}
