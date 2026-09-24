import type { MangaPage } from "../../shared/libraryTypes";
import type { McpLetteringCommand } from "../../shared/mcpLettering";
import { isManualBubbleLayout } from "../../shared/bubbleLayout";
import { applyBubbleNaturalTextLayout } from "../inpainting/bubbleLayoutNaturalText";
import {
  runBubbleLayoutPostprocess,
  type BubbleLayoutRunner,
} from "../inpainting/bubbleLayoutRunner";
import { McpEditError } from "../application/mcpEditPolicy";

type Command = Extract<McpLetteringCommand, { kind: "layout" }>;
export function mcpLayoutExclusion(
  block: MangaPage["blocks"][number],
  command: Command,
) {
  if (block.generatedLettering) return "generated_lettering";
  if (block.textRole === "sound") return "sound_effect_block";
  if (block.curveLayout) return "curve_layout_preserved";
  if (!block.translatedText.trim()) return "empty_translation";
  if (command.preserveManualLayout && isManualBubbleLayout(block.bubbleLayout))
    return "manual_layout_preserved";
  if (command.mode !== "wrap" && block.inpaintExcluded)
    return "app_layout_excludes_inpaint_excluded_blocks";
  return null;
}
/** No OCR/translation/erasure/save; only native render geometry and optional natural wrapping. */
export async function prepareMcpLetteringLayout(
  page: MangaPage,
  blockIds: string[],
  command: Command,
  signal: AbortSignal,
  runner?: BubbleLayoutRunner,
) {
  signal.throwIfAborted();
  let result = structuredClone(page);
  if (command.mode !== "wrap" && blockIds.length) {
    if (!runner || !command.allowAssetDownloads)
      throw new McpEditError(
        "invalid_edit",
        "Geometry detection requires explicit model-asset permission.",
      );
    const processed = await runBubbleLayoutPostprocess({
      page: result,
      blockIds,
      runner,
      signal,
      failureMode: "required",
      config: {
        policy: command.policy,
        paddingRatio: command.paddingRatio,
        overwriteManual: !command.preserveManualLayout,
      },
    });
    result = processed.page;
  }
  signal.throwIfAborted();
  if (command.mode !== "geometry") {
    const wrapIds = blockIds.filter((id) => {
      const block = page.blocks.find((item) => item.id === id);
      return (
        block &&
        (!command.preserveExistingLineBreaks ||
          !/[\r\n]/u.test(block.translatedText))
      );
    });
    result = applyBubbleNaturalTextLayout(
      result,
      { locale: command.locale },
      undefined,
      wrapIds,
    );
  }
  signal.throwIfAborted();
  return result;
}
