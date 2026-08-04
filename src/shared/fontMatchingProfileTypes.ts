/** Keep byte-for-byte role values aligned with font_matching_labels.py. */
export const FONT_MATCHING_SEMANTIC_ROLES = [
  "dialogue",
  "narration",
  "thought",
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
  "other",
  "unknown_needs_review",
] as const;

export type FontMatchingSemanticRole =
  (typeof FONT_MATCHING_SEMANTIC_ROLES)[number];

export const FONT_MATCHING_PALETTE_ROLES = [
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
  "other",
] as const;

export type FontMatchingPaletteRole =
  (typeof FONT_MATCHING_PALETTE_ROLES)[number];

export const FONT_MATCHING_SOURCE_STYLE_AXES = [
  "serifness",
  "weight",
  "width",
  "roundness",
  "strokeContrast",
  "handwritten",
  "angularity",
  "irregularity",
  "slant",
  "energy",
] as const;

export type FontMatchingSourceStyleAxis =
  (typeof FONT_MATCHING_SOURCE_STYLE_AXES)[number];

export type FontMatchingSourceStyleV2 = {
  serifness: number | null;
  weight: number | null;
  width: number | null;
  roundness: number | null;
  strokeContrast: number | null;
  handwritten: number | null;
  angularity: number | null;
  irregularity: number | null;
  slant: number | null;
  energy: number | null;
  unknownFields: FontMatchingSourceStyleAxis[];
};

export type FontMatchingTreatmentV2 = {
  orientation: "horizontal" | "vertical";
  outline: "none" | "single" | "multiple" | "unknown";
  shadow: "none" | "hard" | "soft" | "unknown";
  fill: "solid" | "gradient" | "pattern" | "unknown";
  distortion: "none" | "perspective" | "curved" | "warped" | "unknown";
  polarity: "normal" | "inverse" | "unknown";
  colorMode: "monochrome" | "color" | "unknown";
};

export type FontMatchRolePredictionV2 = {
  primary: FontMatchingSemanticRole;
  confidence: number;
  alternatives: Array<{
    role: FontMatchingSemanticRole;
    confidence: number;
  }>;
};

export type RankedFontCandidateV2 = {
  rank: number;
  /** Pixel-model order before supervised top3 calibration mutates scores. */
  rawPixelRank?: number;
  /** Pixel-model probability before supervised top3 calibration. */
  rawPixelScore?: number;
  fontId: string;
  renderStatus: "rendered" | "unrenderable";
  unrenderableReason: string | null;
  styleFit: number;
  roleFit: number;
  layoutFit: number | null;
  glyphCoverage: number | null;
  workProfileFit: number;
  userPreferenceFit: number;
  genrePriorContribution: number;
  switchPenalty: number;
  totalScore: number;
  confidence: number;
  reasonCodes: string[];
};

export const FONT_MATCHING_DECISION_PRIORITY = [
  "block_user_lock",
  "work_role_user_lock",
  "work_profile",
  "v2_automatic",
  "user_default_or_top3",
] as const;

export type FontMatchingDecisionPrioritySource =
  (typeof FONT_MATCHING_DECISION_PRIORITY)[number];

export type FontMatchAbstainReason =
  | "no_acceptable_candidate"
  | "low_confidence"
  | "unrenderable_translation"
  | "role_unknown"
  | "profile_conflict"
  | "catalog_mismatch";

export type FontMatchDecisionV2 =
  | {
      mode: "apply";
      selectedFontId: string;
      topCandidateFontIds: string[];
      noneAcceptable: false;
      abstainReason: null;
      resolvedBy: Exclude<
        FontMatchingDecisionPrioritySource,
        "user_default_or_top3"
      >;
    }
  | {
      mode: "suggest";
      selectedFontId: null;
      topCandidateFontIds: string[];
      noneAcceptable: false;
      abstainReason: null;
      resolvedBy: "user_default_or_top3";
    }
  | {
      mode: "abstain";
      selectedFontId: null;
      topCandidateFontIds: string[];
      noneAcceptable: boolean;
      abstainReason: FontMatchAbstainReason;
      resolvedBy: "user_default_or_top3";
    };

export type FontMatchDecisionEvidenceV2 = {
  schemaVersion: 2;
  workId: string;
  chapterId: string;
  pageId: string;
  blockId: string;
  role: FontMatchRolePredictionV2;
  sourceStyle: FontMatchingSourceStyleV2;
  treatment: FontMatchingTreatmentV2;
  rankedCandidates: RankedFontCandidateV2[];
  decision: FontMatchDecisionV2;
  catalogVersion: string;
  modelVersion: string;
  rendererHash: string;
  createdAt: string;
};

export type FontStyleSelectionV2 = {
  fontId: string;
  fontWeight?: number;
  italic?: boolean;
  outlineWidthScale?: number;
};

export type TypographyAnchorV2 = {
  primaryFontId: string;
  allowedFontIds: string[];
  origin: "learned" | "manual" | "migrated";
  evidenceCount: number;
  confidence: number;
  replacementPolicy: {
    minimumEvidenceCount: number;
    minimumScoreMargin: number;
  };
  updatedAt: string;
};

export type RoleFontPaletteV2 = {
  role: FontMatchingPaletteRole;
  allowedFontIds: string[];
  maxDistinctFonts: number;
  reuseVisualClusterFont: true;
  evidenceCount: number;
  confidence: number;
};

export type IntentionalTypographyOverrideV2 = {
  id: string;
  scope:
    | {
        type: "block";
        chapterId: string;
        pageId: string;
        blockId: string;
      }
    | { type: "visual_cluster"; visualClusterId: string };
  role: FontMatchingSemanticRole;
  selection: FontStyleSelectionV2;
  reasonCode: string;
  origin: "model" | "user" | "adjudicated";
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkTypographyUserLockV2 = {
  id: string;
  scope:
    | { type: "role"; role: FontMatchingSemanticRole }
    | {
        type: "block";
        chapterId: string;
        pageId: string;
        blockId: string;
      };
  selection: FontStyleSelectionV2;
  createdAt: string;
  updatedAt: string;
};

export type WorkTypographyGenrePriorV2 = {
  source: "manual" | "context_model";
  labels: Array<{ label: string; probability: number }>;
  styleBias: Partial<Record<FontMatchingSourceStyleAxis, number>>;
  maxScoreContribution: number;
};

export type WorkTypographyProfileV2 = {
  schemaVersion: 2;
  workId: string;
  dialogueAnchor: TypographyAnchorV2 | null;
  narrationAnchor: TypographyAnchorV2 | null;
  thoughtAnchor: TypographyAnchorV2 | null;
  rolePalettes: RoleFontPaletteV2[];
  intentionalOverrides: IntentionalTypographyOverrideV2[];
  userLocks: WorkTypographyUserLockV2[];
  orientationPolicy: {
    horizontalAllowedFontIds: string[] | null;
    verticalAllowedFontIds: string[] | null;
    verticalOnlyFontIds: string[];
  };
  consistencyPolicy: {
    reuseBodyAnchors: true;
    requireIntentionalOverrideForBodySwitch: true;
    reuseVisualClusterFont: true;
    maxAccentFontsPerRole: number;
  };
  genrePrior: WorkTypographyGenrePriorV2 | null;
  evidenceCount: number;
  confidence: number;
  catalogVersion: string;
  modelVersion: string;
  rendererHash: string;
  createdAt: string;
  updatedAt: string;
};
