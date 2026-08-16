import type { TextStyleRun } from "../../../shared/richTextMarkup";
import type { TranslationBlock } from "../../../shared/textTypes";
import { resolveBlockFontFamily, type BlockFontCatalog } from "./fonts";

export type TextRunRenderStyle = {
  fontSizePx: number;
  fontFamily: string;
  opacity: number;
};

export type TextRunStyleResolver = (run: TextStyleRun) => TextRunRenderStyle;

export function createTextRunStyleResolver(
  block: TranslationBlock,
  renderedBaseFontSizePx: number,
  fontCatalog: BlockFontCatalog,
): TextRunStyleResolver {
  const storedBaseFontSizePx = Math.max(1, block.fontSizePx || 1);
  const scale = renderedBaseFontSizePx / storedBaseFontSizePx;
  const baseOpacity = normalizeOpacity(block.textOpacity);
  return (run) => ({
    fontSizePx: Math.max(0.01, (run.sizePx ?? storedBaseFontSizePx) * scale),
    fontFamily: resolveBlockFontFamily(
      run.fontFamily ?? block.fontFamily,
      fontCatalog,
    ),
    opacity: run.opacity ?? baseOpacity,
  });
}

export function resolveMaximumTextRunFontSizePx(
  runs: readonly TextStyleRun[],
  block: TranslationBlock,
  renderedBaseFontSizePx: number,
): number {
  const storedBaseFontSizePx = Math.max(1, block.fontSizePx || 1);
  const scale = renderedBaseFontSizePx / storedBaseFontSizePx;
  return runs.reduce(
    (largest, run) =>
      Math.max(largest, (run.sizePx ?? storedBaseFontSizePx) * scale),
    renderedBaseFontSizePx,
  );
}

function normalizeOpacity(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value as number));
}
