import type { BubbleLayoutPolicy } from "../../shared/inpaintingTypes";
import type { BBox } from "../../shared/textTypes";

export type RefinedBubbleRegion = {
  /** Page-space pixel bounds for the local mask. */
  bounds: BBox;
  /** Row-major binary mask local to `bounds`. */
  mask: Uint8Array;
  width: number;
  height: number;
  area: number;
};

export type BubbleMaskRefinementInput = {
  bitmap: Uint8Array;
  imageWidth: number;
  imageHeight: number;
  bubbleBox: BBox;
  promptBoxes: BBox[];
  fontSizePx: number;
  outlineWidthPx: number;
  policy: BubbleLayoutPolicy;
  /**
   * The manual layout-only action can run against the original page before
   * inpainting. In that case dark source glyphs are still present inside the
   * OCR prompts and may falsely split the light balloon interior.
   */
  repairOriginalTextInk?: boolean;
};

export type BubbleMaskRefinementResult = {
  regions: RefinedBubbleRegion[];
  confidence: number;
  insetPx: number;
  promptCoverage: number;
};
