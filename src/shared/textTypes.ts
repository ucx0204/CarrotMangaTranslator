import type { BubbleLayout } from "./bubbleLayout";
import type { FontMatchingSemanticRole } from "./fontMatchingProfileTypes";

export type BlockType = "nonsolid";

export type SourceTextDirection = "horizontal" | "vertical";
export type RenderTextDirection = "horizontal" | "vertical";
export type ReviewStatus = "draft" | "needs_review" | "reviewed";
export type TextWordBreak = "normal" | "break-all" | "keep-all" | "break-word";

type AutomaticFontMatchRecord = {
  schemaVersion: 1;
  selectedFontId: string;
  role: FontMatchingSemanticRole;
  confidence: number;
  source: "episode_consistency" | "local_visual" | "work_profile" | "user_lock";
  previousStyle: {
    fontFamily: string | null;
    bold: boolean | null;
    italic: boolean | null;
    outlineWidthScale: number | null;
    /** Optional for backward compatibility with pre-polarity provenance. */
    textColor?: string;
    /** Null restores the absence of an outline color. */
    outlineColor?: string | null;
  };
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
  bbox: BBox;
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
  renderDirection: RenderTextDirection;
  rotationDeg?: number;
  perspectiveTransform?: PerspectiveTransform;
  curveLayout?: CurveLayout;
  warpTransform?: WarpTransform;
  fontFamily?: string;
  /** Provenance plus an exact one-click rollback for an automatic V2 choice. */
  automaticFontMatch?: AutomaticFontMatchRecord;
  fontSizePx: number;
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
