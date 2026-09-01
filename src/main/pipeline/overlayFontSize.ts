import {
  applyFormatDefaultsToBlock,
  type BlockFormatDefaults,
} from "../../shared/blockFormat";
import type { TranslationBlock } from "../../shared/textTypes";

export type OverlayFontSizeOptions = {
  aiFontSizeMatching?: boolean;
  /** @deprecated Compatibility with callers from before the intent split. */
  fontSizeAutoFit?: boolean;
  sourceFontSize?: {
    confidence: number;
    facePx: number;
    method: "raster-core-v1";
  };
};

export function applySizeOptions(
  block: TranslationBlock,
  formatDefaults: BlockFormatDefaults | undefined,
  options: OverlayFontSizeOptions | undefined,
): TranslationBlock {
  const formatted = applyFormatDefaultsToBlock(block, formatDefaults);
  const sourceAware = options?.sourceFontSize
    ? {
        ...formatted,
        sourceFontFacePx: options.sourceFontSize.facePx,
        sourceFontSizeConfidence: options.sourceFontSize.confidence,
        sourceFontSizeMethod: options.sourceFontSize.method,
      }
    : formatted;
  const aiFontSizeMatching =
    options?.aiFontSizeMatching ?? options?.fontSizeAutoFit;
  if (aiFontSizeMatching === undefined) return sourceAware;
  return {
    ...sourceAware,
    autoFitText: false,
    fontSizePx: block.fontSizePx,
    fontSizeIntent: aiFontSizeMatching ? "source-match" : "manual",
  };
}
