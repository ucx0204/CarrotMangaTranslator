import type { BubbleLayout } from "./bubbleLayout";
import type { FontMatchingSemanticRole } from "./fontMatchingProfileTypes";

export type BlockType = "nonsolid";

export type SourceTextDirection = "horizontal" | "vertical";
export type RenderTextDirection = "horizontal" | "vertical";
export type TextLayoutIntent = "auto" | "horizontal" | "vertical";
export type ReviewStatus = "draft" | "needs_review" | "reviewed";
export type TextWordBreak =
  | "normal"
  | "break-word"
  | "break-all"
  | "keep-all"
  | "keep-all-overflow";

export type TextEffect = {
  enabled: boolean;
  color: string;
  offsetXpx: number;
  offsetYpx: number;
  blurPx: number;
  opacity: number;
};

export type TextGlow = {
  enabled: boolean;
  color: string;
  blurPx: number;
  opacity: number;
};

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

export type WarpGridSize = 3 | 5;

/**
 * Smooth block-local mesh deformation. `gridSize` is the number of cells on
 * each axis (Photoshop-compatible terminology), so the point lattice contains
 * `(gridSize + 1)²` row-major anchors.
 */
export type WarpTransform = {
  version: 1;
  gridSize: WarpGridSize;
  points: Point[];
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
  /** Source OCR/inpainting geometry, always confined to the page. */
  bbox: BBox;
  /** Optional user-authored visual geometry; may extend beyond the page. */
  renderBbox?: BBox;
  bboxSpace?: "normalized_1000" | "pixels";
  renderBboxSpace?: "normalized_1000" | "pixels";
  /**
   * Shape-aware usable text regions relative to `renderBbox ?? bbox`.
   * This is per-block geometry, not a reusable formatting default.
   */
  bubbleLayout?: BubbleLayout;
  sourceText: string;
  translatedText: string;
  /** Persisted visual role so keep-block retranslations do not guess by length. */
  textRole?: "ordinary" | "sound";
  /** V2 visual typography intent, persisted for stable retranslations. */
  fontRole?: FontMatchingSemanticRole;
  /** Confidence in `fontRole`, independent of translation confidence. */
  fontRoleConfidence?: number;
  /** Canonical page-local identifier for repeated accent lettering. */
  visualClusterId?: string;
  confidence: number;
  sourceDirection: SourceTextDirection;
  /** Gemma-authored advisory. Code applies vertical only after strict non-bubble validation. */
  layoutIntent?: TextLayoutIntent;
  /** A persisted user/default direction claim; future model advisories must not replace it. */
  layoutIntentSuppressed?: true;
  renderDirection: RenderTextDirection;
  rotationDeg?: number;
  perspectiveTransform?: PerspectiveTransform;
  curveLayout?: CurveLayout;
  warpTransform?: WarpTransform;
  fontFamily?: string;
  fontSizePx: number;
  /** Visible source-glyph face measured from the immutable page raster. */
  sourceFontFacePx?: number;
  /** Confidence of sourceFontFacePx. Missing means no automatic source cap. */
  sourceFontSizeConfidence?: number;
  /** Auditable producer revision for the optional source-face measurement. */
  sourceFontSizeMethod?: "raster-core-v1";
  lineHeight: number;
  letterSpacing?: number;
  /** Horizontal glyph scale (장평). 1 = natural width. Undefined means 1. */
  fontWidthScale?: number;
  /** Line-breaking policy. Undefined preserves the direction-specific legacy behavior. */
  wordBreak?: TextWordBreak;
  textAlign: "left" | "center" | "right";
  textColor: string;
  /** Opacity of rendered text and its outline. Undefined means fully opaque. */
  textOpacity?: number;
  outlineColor?: string;
  /** User-authored absolute outline thickness. Undefined preserves legacy scale behavior. */
  outlineWidthPx?: number;
  outlineWidthScale?: number;
  /** A second outline painted outside the primary text outline. */
  outerOutlineColor?: string;
  outerOutlineWidthPx?: number;
  /** Optional block-wide directional shadow rendered after text and outline composition. */
  textEffect?: TextEffect;
  /** Optional glow kept separate from the directional text shadow. */
  textGlow?: TextGlow;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Japanese/Korean emphasis dots; unrelated to letter spacing. */
  emphasisMark?: boolean;
  /** Paint the complete text box before drawing text, including exports. */
  textBackgroundEnabled?: boolean;
  textBackgroundColor?: string;
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
