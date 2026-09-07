import type { KoharuTypographySegmentation } from "../bubbleLayout/contracts";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import {
  buildKoharuTypographyCompositeMask,
  resolveKoharuTypographyFeatherPx,
  unionWindowMasks,
} from "./koharuTypographyMask";
import type { PixelRect } from "./maskGeometry";

export function resolvePatternFluxCompositePlan(options: {
  block: TranslationBlock;
  fallbackConstraint: InpaintingWindowMask | null;
  height: number;
  page: MangaPage;
  regionMask: InpaintingWindowMask;
  segmentation?: KoharuTypographySegmentation;
  sourceRect: PixelRect;
  width: number;
  regionOnly?: boolean;
}): {
  compositeMask: InpaintingWindowMask;
  constraint: InpaintingWindowMask | null;
  featherPx: number;
  modelMask: InpaintingWindowMask;
  usesTypographySegmentation: boolean;
} {
  const featherPx = resolveKoharuTypographyFeatherPx(
    options.block,
    options.page,
  );
  if (options.regionOnly)
    return {
      compositeMask: options.regionMask,
      constraint: options.regionMask,
      featherPx: 0,
      modelMask: options.regionMask,
      usesTypographySegmentation: false,
    };
  const typography = options.segmentation
    ? buildKoharuTypographyCompositeMask({
        block: options.block,
        featherPx,
        height: options.height,
        ...(options.fallbackConstraint
          ? { ownedRegionMask: options.fallbackConstraint }
          : {}),
        page: options.page,
        segmentation: options.segmentation,
        sourceRect: options.sourceRect,
        width: options.width,
      })
    : null;
  if (!typography) {
    return {
      compositeMask: options.regionMask,
      constraint: options.fallbackConstraint,
      featherPx,
      modelMask: options.regionMask,
      usesTypographySegmentation: false,
    };
  }
  return {
    compositeMask: typography.core,
    constraint: typography.featherEnvelope,
    featherPx,
    modelMask: unionWindowMasks(options.regionMask, typography.featherEnvelope),
    usesTypographySegmentation: true,
  };
}
