export type BlockType = "nonsolid";

export type SourceTextDirection = "horizontal" | "vertical";
export type RenderTextDirection = "horizontal" | "vertical";
export type ReviewStatus = "draft" | "needs_review" | "reviewed";

export type BBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type TranslationBlock = {
  id: string;
  type: BlockType;
  bbox: BBox;
  renderBbox?: BBox;
  bboxSpace?: "normalized_1000" | "pixels";
  renderBboxSpace?: "normalized_1000" | "pixels";
  sourceText: string;
  translatedText: string;
  confidence: number;
  sourceDirection: SourceTextDirection;
  renderDirection: RenderTextDirection;
  rotationDeg?: number;
  fontFamily?: string;
  fontSizePx: number;
  lineHeight: number;
  letterSpacing?: number;
  /** Horizontal glyph scale (장평). 1 = natural width. Undefined means 1. */
  fontWidthScale?: number;
  textAlign: "left" | "center" | "right";
  textColor: string;
  outlineColor?: string;
  outlineWidthScale?: number;
  bold?: boolean;
  italic?: boolean;
  backgroundColor: string;
  opacity: number;
  autoFitText?: boolean;
  inpaintExcluded?: boolean;
  reviewStatus?: ReviewStatus;
  reviewNote?: string;
  speakerId?: string;
  glossaryEntryIds?: string[];
};
