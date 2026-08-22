import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { PixelRect } from "./maskGeometry";
import type { SourceGlyphEvidence } from "./sourceGlyphResidual";

export type PatternMaskContext = {
  pageMask: Uint8Array;
  inpaintWindows: PixelRect[];
  inpaintWindowMasks: InpaintingWindowMask[];
  inpaintCompositeMasks: InpaintingWindowMask[];
  inpaintCompositeFeatherPx: number[];
  inpaintWindowConstraints: Array<InpaintingWindowMask | null>;
  inpaintWindowGroupIds: string[][];
  usesKoharuTypographyComposite: boolean;
  validationWindowMasks: InpaintingWindowMask[];
  validationBlockIds: string[];
  sourceGlyphEvidence: SourceGlyphEvidence[];
  validationBindingsByBlockId: Map<
    string,
    {
      blockId: string;
      firstPassCore: InpaintingWindowMask;
      sourceGlyphEvidence: SourceGlyphEvidence;
    }
  >;
  blocksErased: number;
  otsuBlocks: number;
};

export function createEmptyPatternMaskContext(
  width: number,
  height: number,
): PatternMaskContext {
  return {
    pageMask: new Uint8Array(width * height),
    inpaintWindows: [],
    inpaintWindowMasks: [],
    inpaintCompositeMasks: [],
    inpaintCompositeFeatherPx: [],
    inpaintWindowConstraints: [],
    inpaintWindowGroupIds: [],
    usesKoharuTypographyComposite: false,
    validationWindowMasks: [],
    validationBlockIds: [],
    sourceGlyphEvidence: [],
    validationBindingsByBlockId: new Map(),
    blocksErased: 0,
    otsuBlocks: 0,
  };
}
