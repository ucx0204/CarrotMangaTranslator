export const FONT_EXPRESSION_CONTRACT = "font-expression-ink-v1";
export const FONT_EXPRESSION_MODEL_SHA256 =
  "71f15f0b1bef9fd57fcf20246586cdbe06749bf31d60e2bfdd26f3a1d788a183";
export const FONT_EXPRESSION_CLASSES = [
  "body",
  "scribble",
  "brush",
  "heavy_sans",
  "heavy_serif",
  "display",
] as const;

export type FontExpressionInference = Readonly<{
  contractVersion: typeof FONT_EXPRESSION_CONTRACT;
  modelSha256: string;
  componentCount: number;
  probabilities: readonly number[];
}>;
