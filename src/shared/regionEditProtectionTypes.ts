import type { LetteringMaskStroke } from "./generatedLetteringMaskTypes";

export type RegionEditProtection = {
  strokes: LetteringMaskStroke[];
  maskDataUrl: string;
  /** Region-specific reference masks; maskDataUrl above is their editable union. */
  regions?: Array<{ regionId: string; maskDataUrl: string }>;
};
