import type { TranslationOptions } from "../appSettings";
import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import type { OpenAICompatibleApiEndpoint } from "../openaiApiEndpoint";
import type { CodexAppServerEndpoint } from "../codexAppServerEndpoint";
import type {
  BBox,
  SourceTextDirection,
  TextLayoutIntent,
} from "../../shared/textTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  PageStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import type { PixelRect } from "../../shared/region";
import type { ChapterRunPaths } from "../library";
import type { FontMatchingSemanticRole } from "../../shared/fontMatchingProfileTypes";
import type { CumulativeContextDetail } from "../../shared/settingsTypes";
import type { SoundEffectReviewRegion } from "../../shared/soundEffectReview";
import type { PageProcessingTimingCollector } from "./pageProcessingTiming";
import type { PreparedTranslationCheckpoint } from "./preparedTranslationCheckpointContract";

export type PipelineOptions = {
  jobId: string;
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  emit: (event: JobEvent) => void;
  signal: AbortSignal;
  /** Shared renderer-owned timing session; omitted for region/tests/legacy calls. */
  timing?: PageProcessingTimingCollector;
  skipOcrPrepass?: boolean;
  blockMode?: "auto" | "keep";
  /** webp 등 nativeImage가 못 읽는 이미지의 PNG 디코더 (keep 모드 블록 크롭 OCR용). */
  decodeImage?: (filePath: string) => Promise<Buffer | null>;
  onCleanupReady?: (cleanup: () => Promise<void>) => void;
  /** Persist a validated model-stage result before it may feed rolling context. */
  onPagePrepared?: (
    checkpoint: PreparedTranslationCheckpoint,
  ) => Promise<boolean | void>;
  /** Return false when the translated page was rejected by optimistic concurrency checks. */
  onPageComplete?: (page: MangaPage) => Promise<boolean | void>;
  /** Return the accepted page IDs when a batch is guarded by optimistic concurrency. */
  onPagesComplete?: (pages: MangaPage[]) => Promise<ReadonlySet<string> | void>;
  onPageFailed?: (page: MangaPage, errorMessage: string) => Promise<void>;
  workContext?: PipelineWorkContext;
  regionContext?: PipelineRegionContext;
  writeStoryMemory?: boolean;
  collectPageContext?: boolean;
  cumulativeContextDetail?: CumulativeContextDetail;
  naturalTextLayout?: boolean;
  /** Match only sealed, verified built-in candidates before line and bubble layout. */
  autoFontMatching?: boolean;
  /** Match nominal size to source glyph pixels without enabling box fitting. */
  aiFontSizeMatching?: boolean;
  /** @deprecated Compatibility with older callers. */
  fontSizeAutoFit?: boolean;
  /** Canonical zero-based positions in the complete chapter, independent of run selection. */
  canonicalPageIndexById?: ReadonlyMap<string, number>;
  /** File-validated candidates; pipeline settings perform the final compatibility gate. */
  translationCheckpoints?: ReadonlyMap<string, PreparedTranslationCheckpoint>;
  /** Canonical chapter pages used to restore verified font continuity. */
  fontContinuityPages?: readonly MangaPage[];
};

export type PipelineRegionContext = {
  sourcePage: MangaPage;
  sourcePageIndex: number;
  cropRect: PixelRect;
};

export type PipelineWorkContext = {
  workId: string;
  /** Display/prompt context only; automatic font matching must not infer style from it. */
  workTitle?: string;
  chapterId: string;
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
  recentPageCount?: number;
  /** Prompt-only live pages from preceding chapters; never persisted into this chapter. */
  previousStoryPages?: PageStoryMemory[];
};

type ServerHandle = {
  baseUrl: string;
  child: unknown;
  startedByScript: boolean;
};

export type ModelEndpointHandle =
  | ServerHandle
  | CodexAppServerEndpoint
  | OpenAICompatibleApiEndpoint;

export type TranslationResult = {
  outputText: string;
  rawResponse: unknown;
  requestBody: RequestSummary | unknown;
};

export type PageContextGlossaryCandidate = {
  source: string;
  target: string;
  category: "character" | "alias" | "place" | "term" | "honorific" | "other";
  aliases?: string[];
  note?: string;
};

export type PageContextCharacterCandidate = {
  displayName: string;
  sourceNames: string[];
  targetName: string;
  aliases?: string[];
  speechStyle?:
    | "neutral"
    | "polite"
    | "casual"
    | "rough"
    | "childish"
    | "elderly"
    | "formal"
    | "custom";
  customSpeechStyle?: string;
  note?: string;
};

export type PageContextPayload = {
  visualSummary?: string;
  glossary: PageContextGlossaryCandidate[];
  characters: PageContextCharacterCandidate[];
};

export type CompletedPageBuildResult = {
  kind: "completed";
  page: MangaPage;
  warnings: string[];
  detail: string;
  pageContext?: PageContextPayload;
};

export type OcrBboxResult = {
  hints: unknown[];
  effectReviewRegions?: SoundEffectReviewRegion[];
  diagnostics: unknown[];
  noTextDetected?: boolean;
  textEvidenceCount?: number;
  /**
   * Optional Anime YOLO pass state. Missing means that no detector run was
   * needed. "unavailable" is persisted so a later run retries only this
   * inexpensive evidence pass instead of rerunning the selected OCR engine.
   */
  groupingEvidence?: {
    contractVersion: 1;
    status: "completed" | "unavailable";
  };
};

export type OverlayItem = {
  id: number;
  /** Raw OCR candidates assigned to this physical text container. */
  candidateIds?: number[];
  /** Code-owned membership; the general model-output parser never supplies it. */
  sourceCandidateMembership?: FontMatchingOcrCandidateMembershipV2;
  /** Code-owned OCR line crops for source-face measurement; model values are stripped. */
  sourceFontLineGeometry?: SourceFontLineGeometryV1;
  type: string;
  textRole?: "sound" | "ordinary" | "nontext" | string;
  /** Fine-grained visual role used only by Font Matching V2. */
  fontRole?: FontMatchingSemanticRole;
  /** Calibrated visual-role confidence supplied by the page model. */
  fontRoleConfidence?: number;
  /** Canonical page-local identifier for repeated accent lettering. */
  visualClusterId?: string;
  bbox: BBox;
  /** 하위 호환 별칭. 신규 코드는 sourceText/translatedText를 우선 사용한다. */
  jp: string;
  ko: string;
  /** 언어 중립 명칭. 파서는 jp/ko와 항상 같은 값으로 채운다. */
  sourceText?: string;
  translatedText?: string;
  /** Gemma advisory; vertical remains code-gated until bubble detection finishes. */
  layoutIntent?: TextLayoutIntent;
  direction?: SourceTextDirection;
  angle?: number;
  fontSize?: number | null;
  confidence?: number | null;
};

type SourceFontLineGeometryV1 = Readonly<{
  contractVersion: "source-font-line-geometry-v1";
  source: "ocr-geometry-lock";
  lines: readonly Readonly<{
    candidateId: number;
    bbox: BBox;
    sourceText: string;
  }>[];
}>;

export type FontMatchingOcrCandidateMembershipV2 = Readonly<{
  contractVersion: "font-matching-ocr-candidate-membership-v2";
  source:
    | "semantic_ocr_fixed_block_request_v5"
    | "semantic_ocr_fixed_block_request_v6"
    | "sealed_font_input_request_block_v2";
  bindingId: string;
  originalCandidateIds: readonly number[];
  /** Code-owned non-ruby candidates that are allowed to vote on direction. */
  voterCandidateIds: readonly number[];
}>;

export type DetectedBboxSpace = "normalized_1000" | "pixels";

export type RequestSummary = {
  bboxCoordinateSpace?: DetectedBboxSpace;
  bboxCoordinateFrame?: {
    width?: number;
    height?: number;
  };
  ocrBboxHints?: Array<{
    id?: number;
    label?: string;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
    ocrText?: string;
    score?: number | null;
    groupId?: string | null;
    rolePrior?: string | null;
    containerType?: string | null;
    orderInGroup?: number | null;
    groupSize?: number;
    semanticGroup?: boolean;
    geometryLocked?: boolean;
    recognitionSegments?: Array<{
      x1?: number;
      y1?: number;
      x2?: number;
      y2?: number;
      ocrText?: string | null;
    }>;
  }>;
  ocrPipeline?: TranslationOptions["ocrPipeline"];
  fixedBlockTranslationVersion?: number;
  fixedBlockIds?: string[];
  fixedBlockCandidateIds?: number[][];
  fixedBlockDirectionVoterCandidateIds?: number[][];
  previousBlocksForPrompt?: PreviousOverlayBlockForPrompt[];
  strictRefineMode?: boolean;
  ocrGeometryOnlyMode?: boolean;
  noTextDetected?: boolean;
  ocrTextEvidenceCount?: number;
};

export type BboxNormalizationOptions = {
  coordinateSpace?: DetectedBboxSpace;
  pixelWidth?: number;
  pixelHeight?: number;
};

export type RuntimeModules = {
  animeTextRelations: {
    hasPotentialAnimeTextRelation: (hints: unknown[]) => boolean;
    qualifyAnimeTextRelationRegionIds: (hints: unknown[]) => string[];
  };
  simplePage: {
    collectOcrBboxHints: (
      options: TranslationOptions,
    ) => Promise<OcrBboxResult>;
    collectOcrBboxHintsBatch?: (
      options: TranslationOptions[],
    ) => Promise<OcrBboxResult[]>;
    /** Waits until every OCR child process has closed and released its model. */
    waitForOcrIdle?: () => Promise<void>;
    requestTranslation: (
      server: ModelEndpointHandle,
      options: TranslationOptions,
    ) => Promise<TranslationResult>;
    saveArtifacts: (
      options: TranslationOptions,
      result: TranslationResult,
    ) => Promise<void>;
    startServer: (options: TranslationOptions) => Promise<ServerHandle>;
    stopServer: (server: ServerHandle | null | undefined) => Promise<void>;
    isModelCached: (options: TranslationOptions) => boolean;
  };
  overlayTools: {
    normalizeItems: (parsed: unknown) => OverlayItem[];
    normalizeRegionSingleItem: (parsed: unknown) => OverlayItem[];
    parseJsonLenient: (rawText: string) => unknown;
    parseRegionSingleItem: (rawText: string) => unknown;
  };
};
