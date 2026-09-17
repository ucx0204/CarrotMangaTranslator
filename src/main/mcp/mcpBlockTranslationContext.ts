import type { McpBlockTranslationInput } from "../application/mcpBlockTranslationService";
import type { TranslationOptions } from "../appSettings";
import { resolveWorkContextForChapter } from "../library";
import { buildPromptWorkContextForPage } from "../pipeline/workContextPrompt";
import { prunePromptWorkContextForBudget } from "../../shared/workContextBudget";
import { hashStableValue } from "../../shared/blockFingerprint";
import { loadAppRuntimeModule, assertRuntimeFunctions } from "../runtimeModuleLoader";
import { McpEditError } from "../application/mcpEditPolicy";

/** Reuse the app formatter, limits and ranking; never analyze or save memory. */
export async function readMcpBlockTranslationContext(
  input: McpBlockTranslationInput,
  options: TranslationOptions,
) {
  if (input.contextMode === "none")
    return { text: "", revision: hashStableValue([input.workId, "none"]), pruned: false };
  const saved = await resolveWorkContextForChapter(input.chapterId);
  if (saved.workId !== input.workId)
    throw new McpEditError("revision_conflict", "The page moved to another work.");
  const selected = buildPromptWorkContextForPage({
    baseStyleGuide: saved.styleGuide,
    storyMemory: {
      ...saved.storyMemory,
      pages: saved.storyMemory.pages.filter((page) => page.pageIndex < input.pageIndex),
    },
    pageId: input.pageId,
    pageIndex: input.pageIndex,
    ocrHints: [{ ocrText: input.sourceText }],
  });
  const bounded = prunePromptWorkContextForBudget(selected, {
    ctx: options.ctx,
    maxTokens: options.maxTokens,
    baseInputTokens: 1024 + Math.ceil(input.sourceText.length / 2),
    minOutputHeadroomTokens: Math.min(options.maxTokens, 2048),
  });
  const formatter = loadAppRuntimeModule("workContextPrompt");
  assertRuntimeFunctions(formatter, "prompts/work-context.cjs", ["buildWorkContextSection"]);
  const build = formatter.buildWorkContextSection as (value: TranslationOptions) => string[];
  const text = build({ ...options, workContext: bounded.workContext }).join("\n");
  if (text.length > 24_000 || bounded.budget.effective.outputHeadroomTokens < 512)
    throw new McpEditError("invalid_edit", "Saved context exceeds the bounded translation input. Use contextMode none or reduce the saved context explicitly.");
  return {
    text,
    revision: hashStableValue([input.workId, input.pageId, input.pageIndex, text]),
    pruned: bounded.budget.omittedParts.length > 0,
  };
}
