import type { TranslationOptions } from "../appSettings";
import type { OpenAIOAuthEndpoint } from "../openaiOauthEndpoint";
import type { BBox, JobEvent, MangaPage, SourceTextDirection } from "../../shared/types";
import type { ChapterRunPaths } from "../library";

export type PipelineOptions = {
  jobId: string;
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  emit: (event: JobEvent) => void;
  signal: AbortSignal;
  skipOcrPrepass?: boolean;
  onCleanupReady?: (cleanup: () => Promise<void>) => void;
  onPageComplete?: (page: MangaPage) => Promise<void>;
  onPageFailed?: (page: MangaPage, errorMessage: string) => Promise<void>;
};

export type ServerHandle = {
  baseUrl: string;
  child: unknown;
  startedByScript: boolean;
};

export type ModelEndpointHandle = ServerHandle | OpenAIOAuthEndpoint;

export type TranslationResult = {
  outputText: string;
  rawResponse: unknown;
  requestBody: RequestSummary | unknown;
};

export type OcrBboxResult = {
  hints: unknown[];
  diagnostics: unknown[];
  noTextDetected?: boolean;
  textEvidenceCount?: number;
};

export type OverlayItem = {
  id: number;
  type: string;
  textRole?: "sound" | "ordinary" | "nontext" | string;
  bbox: BBox;
  jp: string;
  ko: string;
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
  }>;
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
    collectOcrBboxHints: (options: TranslationOptions) => Promise<OcrBboxResult>;
    collectOcrBboxHintsBatch?: (options: TranslationOptions[]) => Promise<OcrBboxResult[]>;
    requestTranslation: (server: ModelEndpointHandle, options: TranslationOptions) => Promise<TranslationResult>;
    saveArtifacts: (options: TranslationOptions, result: TranslationResult) => Promise<void>;
    startServer: (options: TranslationOptions) => Promise<ServerHandle>;
    stopServer: (server: ServerHandle | null | undefined) => Promise<void>;
    isModelCached: (options: TranslationOptions) => boolean;
  };
  overlayTools: {
    normalizeItems: (parsed: unknown) => OverlayItem[];
    parseJsonLenient: (rawText: string) => unknown;
  };
};
