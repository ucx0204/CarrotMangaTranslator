import type { TranslationOptions } from "../appSettings";
import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import type { OpenAICompatibleApiEndpoint } from "../openaiApiEndpoint";
import type { OpenAIOAuthEndpoint } from "../openaiOauthEndpoint";
import type { BBox, SourceTextDirection } from "../../shared/textTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  PageStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import type { PixelRect } from "../../shared/region";
import type { ChapterRunPaths } from "../library";

export type PipelineOptions = {
  jobId: string;
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  emit: (event: JobEvent) => void;
  signal: AbortSignal;
  skipOcrPrepass?: boolean;
  blockMode?: "auto" | "keep";
  /** webp 등 nativeImage가 못 읽는 이미지의 PNG 디코더 (keep 모드 블록 크롭 OCR용). */
  decodeImage?: (filePath: string) => Promise<Buffer | null>;
  onCleanupReady?: (cleanup: () => Promise<void>) => void;
  /** Return false when the translated page was rejected by optimistic concurrency checks. */
  onPageComplete?: (page: MangaPage) => Promise<boolean | void>;
  /** Return the accepted page IDs when a batch is guarded by optimistic concurrency. */
  onPagesComplete?: (pages: MangaPage[]) => Promise<ReadonlySet<string> | void>;
  onPageFailed?: (page: MangaPage, errorMessage: string) => Promise<void>;
  workContext?: PipelineWorkContext;
  regionContext?: PipelineRegionContext;
  writeStoryMemory?: boolean;
  collectPageContext?: boolean;
  /** Canonical zero-based positions in the complete chapter, independent of run selection. */
  canonicalPageIndexById?: ReadonlyMap<string, number>;
};

export type PipelineRegionContext = {
  sourcePage: MangaPage;
  sourcePageIndex: number;
  cropRect: PixelRect;
};

export type PipelineWorkContext = {
  workId: string;
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
  | OpenAIOAuthEndpoint
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
  diagnostics: unknown[];
  noTextDetected?: boolean;
  textEvidenceCount?: number;
};

export type OverlayItem = {
  id: number;
  /** Raw Paddle OCR candidates assigned to this physical text container. */
  candidateIds?: number[];
  type: string;
  textRole?: "sound" | "ordinary" | "nontext" | string;
  bbox: BBox;
  /** 하위 호환 별칭. 신규 코드는 sourceText/translatedText를 우선 사용한다. */
  jp: string;
  ko: string;
  /** 언어 중립 명칭. 파서는 jp/ko와 항상 같은 값으로 채운다. */
  sourceText?: string;
  translatedText?: string;
  direction?: SourceTextDirection;
  angle?: number;
  fontSize?: number | null;
  confidence?: number | null;
};

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
  }>;
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
  simplePage: {
    collectOcrBboxHints: (
      options: TranslationOptions,
    ) => Promise<OcrBboxResult>;
    collectOcrBboxHintsBatch?: (
      options: TranslationOptions[],
    ) => Promise<OcrBboxResult[]>;
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
