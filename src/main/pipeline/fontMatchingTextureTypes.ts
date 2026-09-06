export const FONT_TEXTURE_CONTRACT = "font-texture-ink-v1";
export const FONT_TEXTURE_MODEL_SHA256 =
  "08ab996b60964e1fa4ffb05b942808a212a3856f23d2bb5f65c3d32abb5574ad";
export const FONT_TEXTURE_CLASSES = [
  "ordinary_serif",
  "regular_sans",
  "rounded_print",
  "light_hand",
  "rough_hand",
  "interrupted_hand",
  "medium_brush",
  "heavy_brush",
  "heavy_sans",
  "decorative_serif",
  "other",
] as const;
export const FONT_TEXTURE_WEIGHTS = [
  "light",
  "regular",
  "medium",
  "heavy",
] as const;
export type FontTextureInference = Readonly<{
  contractVersion: typeof FONT_TEXTURE_CONTRACT;
  modelSha256: string;
  patchCount: number;
  probabilities: readonly number[];
  weightProbabilities: readonly number[];
}>;
