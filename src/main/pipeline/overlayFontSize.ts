import {
  applyFormatDefaultsToBlock,
  type BlockFormatDefaults,
} from "../../shared/blockFormat";
import type { TranslationBlock } from "../../shared/textTypes";

export type OverlayFontSizeOptions = {
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
  if (options?.fontSizeAutoFit === undefined) return sourceAware;
  return options.fontSizeAutoFit
    ? { ...sourceAware, autoFitText: true, fontSizePx: block.fontSizePx }
    : {
        ...sourceAware,
        autoFitText: false,
        fontSizePx: formatDefaults?.fontSizePx ?? block.fontSizePx,
      };
}
