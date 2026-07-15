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

/** A point in block-local normalized coordinates. */
export type Point = {
  x: number;
  y: number;
};

/** Corner order is top-left, top-right, bottom-right, bottom-left. */
export type PerspectiveTransform = {
  version: 1;
  corners: [Point, Point, Point, Point];
};

export type QuadraticCurvePath = {
  type: "quadratic";
  start: Point;
  control: Point;
  end: Point;
};

export type CurveLayout = {
  version: 1;
  path: QuadraticCurvePath;
  alignment: "start" | "center" | "end";
  offsetEm: number;
  orientation: "tangent" | "upright";
  reversed?: boolean;
  fitSpacing?: boolean;
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
  perspectiveTransform?: PerspectiveTransform;
  curveLayout?: CurveLayout;
  fontFamily?: string;
  fontSizePx: number;
  lineHeight: number;
  letterSpacing?: number;
  /** Horizontal glyph scale (장평). 1 = natural width. Undefined means 1. */
  fontWidthScale?: number;
  textAlign: "left" | "center" | "right";
  textColor: string;
  /** Opacity of rendered text and its outline. Undefined means fully opaque. */
  textOpacity?: number;
  outlineColor?: string;
  outlineWidthScale?: number;
  bold?: boolean;
  italic?: boolean;
  backgroundColor: string;
  /** Opacity of the editor-only text-block background/chrome. */
  opacity: number;
  autoFitText?: boolean;
  inpaintExcluded?: boolean;
  reviewStatus?: ReviewStatus;
  reviewNote?: string;
  speakerId?: string;
  glossaryEntryIds?: string[];
};
