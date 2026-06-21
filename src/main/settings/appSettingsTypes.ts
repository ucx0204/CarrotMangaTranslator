import type {
  CodexReasoningEffort,
  ApiReasoningEffort,
  GemmaVramMode,
  JobPhase,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend,
  PromptWorkContext,
} from "../../shared/types";

export type TranslationOptions = {
  imagePath: string;
  imageWidth?: number;
  imageHeight?: number;
  pageId?: string;
  pageIndex?: number;
  outputDir: string;
  modelProvider: ModelProvider;
  port: number;
  promptMode: string;
  promptOverrideText?: string;
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;
  ctx: number;
  batch: number;
  ubatch: number;
  gemmaVramMode: GemmaVramMode;
  fitTargetMb: number;
  gpuLayers?: number | "fit";
  cacheTypeK?: string;
  cacheTypeV?: string;
  ctxCheckpoints?: number;
  kvOffload?: boolean;
  mmprojOffload?: boolean;
  threads?: number;
  threadsBatch?: number;
  poll?: number;
  pollBatch?: boolean;
  prioBatch?: number;
  cacheIdleSlots?: boolean;
  cacheReuse?: number;
  enableMetrics?: boolean;
  enablePerf?: boolean;
  draftModelRepo?: string;
  draftModelFile?: string;
  useDraft?: boolean;
  imageMinTokens: number;
  imageMaxTokens: number;
  includeEnhancedVariant: boolean;
  enhancedMaxLongSide: number;
  enhancedContrast: number;
  imageFirst: boolean;
  reuseServer: boolean;
  llamaRuntimeProfile?: string;
  llamaRocmTarget?: string;
  workingDir: string;
  toolsDir: string;
  ocrRuntimeDir?: string;
  serverPath: string;
  modelSource: ModelSource;
  modelRepo: string;
  modelFile: string;
  mmprojRepo?: string;
  mmprojFile?: string;
  localModelPath?: string;
  localMmprojPath?: string;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexOauthPort: number;
  apiBaseUrl: string;
  apiModel: string;
  apiKey?: string;
  apiTemperature?: number | null;
  apiTopP?: number | null;
  apiTopK?: number | null;
  apiReasoningEffort?: ApiReasoningEffort | null;
  apiExtraBodyJson?: string;
  apiCustomHeadersJson?: string;
  ocrDevice: OcrDevice;
  ocrGpuBackend?: OcrGpuBackend;
  ocrGpuCudaTag?: string;
  ocrBboxProvider?: string;
  ocrBboxCommand?: string;
  ocrBboxHintsPath?: string;
  ocrBboxHints?: unknown;
  ocrBboxResult?: {
    hints?: unknown[];
    diagnostics?: unknown[];
    noTextDetected?: boolean;
    textEvidenceCount?: number;
  };
  skipOcrBboxHints?: boolean;
  regionCropMode?: boolean;
  ocrPageIndex?: number;
  ocrPageTotal?: number;
  ocrProgressDefaultToPage?: boolean;
  ocrBatchCompletedBefore?: number;
  ocrBatchTotal?: number;
  onProgress?: (event: {
    phase: JobPhase;
    progressText: string;
    detail?: string;
    progressCurrent?: number;
    progressTotal?: number;
    pageIndex?: number | null;
    pageTotal?: number | null;
    progressMode?: "determinate" | "indeterminate" | "log-only";
    progressPercent?: number;
    progressBytes?: number;
    progressTotalBytes?: number;
    progressBytesPerSecond?: number;
    installLogLine?: string;
  }) => void;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
  llamaCacheDir?: string;
  label: string;
  abortSignal?: AbortSignal;
  workContext?: PromptWorkContext;
};

export type TranslationOptionPaths = {
  isPackaged?: boolean;
  dataRoot: string;
  toolsDir: string;
  ocrRuntimeDir?: string;
  llamaServerPath: string;
  hfHomeDir?: string;
  hfHubCacheDir?: string;
  llamaCacheDir?: string;
};
