import type { McpBlockTranslationInput } from "../application/mcpBlockTranslationService";
import type { TranslationOptions } from "../appSettings";
import { resolveWorkContextForChapter } from "../library";
import { buildPromptWorkContextForPage } from "../pipeline/workContextPrompt";
import { prunePromptWorkContextForBudget } from "../../shared/workContextBudget";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  loadAppRuntimeModule,
  assertRuntimeFunctions,
} from "../runtimeModuleLoader";
import { McpEditError } from "../application/mcpEditPolicy";

/** Reuse the app formatter, limits and ranking; never analyze or save memory. */
export async function readMcpBlockTranslationContext(
  input: McpBlockTranslationInput,
  options: TranslationOptions,
  loadModule: typeof loadAppRuntimeModule = loadAppRuntimeModule,
) {
  // Match the existing context-budget estimate. This is an admission estimate,
  // not a provider tokenizer; neither mode may omit the requested output reserve.
  const baseInputTokens = 1024 + Math.ceil(input.sourceText.length / 2);
  if (options.ctx - baseInputTokens < options.maxTokens)
    throw new McpEditError(
      "invalid_edit",
      "Saved source and requested output exceed the configured context budget. Nothing was sent; reduce the request or adjust the app settings explicitly.",
    );
  if (input.contextMode === "none")
    return {
      text: "",
      revision: hashStableValue([input.workId, "none"]),
      pruned: false,
    };
  const saved = await resolveWorkContextForChapter(input.chapterId);
  if (saved.workId !== input.workId)
    throw new McpEditError(
      "revision_conflict",
      "The page moved to another work.",
    );
  const selected = buildPromptWorkContextForPage({
    baseStyleGuide: saved.styleGuide,
    storyMemory: {
      ...saved.storyMemory,
      pages: saved.storyMemory.pages
        .map((page) => ({
          ...page,
          pageIndex: input.previousPageIds.indexOf(page.pageId),
        }))
        .filter((page) => page.pageIndex >= 0),
    },
    pageId: input.pageId,
    pageIndex: input.pageIndex,
    ocrHints: [{ ocrText: input.sourceText }],
  });
  const bounded = prunePromptWorkContextForBudget(selected, {
    ctx: options.ctx,
    maxTokens: options.maxTokens,
    baseInputTokens,
    minOutputHeadroomTokens: options.maxTokens,
  });
  const formatter = loadModule("workContextPrompt");
  assertRuntimeFunctions(formatter, "prompts/work-context.cjs", [
    "buildWorkContextSection",
  ]);
  const build = formatter.buildWorkContextSection as (
    value: TranslationOptions,
  ) => string[];
  const text = build({ ...options, workContext: bounded.workContext }).join(
    "\n",
  );
  if (
    text.length > 24_000 ||
    bounded.budget.effective.outputHeadroomTokens < options.maxTokens
  )
    throw new McpEditError(
      "invalid_edit",
      "Saved context exceeds the bounded translation input. Use contextMode none or reduce the saved context explicitly.",
    );
  return {
    text,
    revision: hashStableValue([
      input.workId,
      input.pageId,
      input.pageIndex,
      text,
    ]),
    pruned: bounded.budget.omittedParts.length > 0,
  };
}
