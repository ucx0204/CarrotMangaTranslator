import type { BlockFormatDefaults } from "../../shared/blockFormat";
import type {
  CodexReasoningEffort,
  ApiReasoningEffort,
  GemmaVramMode,
  LanguageCode,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend,
} from "../../shared/settingsTypes";
import type { BBox } from "../../shared/textTypes";
import type { JobPhase } from "../../shared/jobTypes";
import type { PromptWorkContext } from "../../shared/workContextTypes";
import type { WorkContextBudgetPlan } from "../../shared/workContextBudget";

export type PreviousOverlayBlockForPrompt = {
  previousId: string;
  index: number;
  candidateId?: number;
  bbox: BBox;
  textRole?: "ordinary" | "sound" | string;
  sourceText: string;
  translatedText: string;
  confidence?: number;
};

export type TranslationOptions = {
  imagePath: string;
  imageWidth?: number;
  imageHeight?: number;
  pageId?: string;
  pageIndex?: number;
  /** Ask the page translation response to append a delimited cumulative context payload. */
  collectPageContext?: boolean;
  strictRefineMode?: boolean;
  keepBlocksMode?: boolean;
  previousBlocksForPrompt?: PreviousOverlayBlockForPrompt[];
  outputDir: string;
  modelProvider: ModelProvider;
  /**
   * 번역 언어쌍. 모델 제공자와 독립이며, 비어 있으면 런타임이 일본어 -> 한국어
   * 기본 프로필로 동작한다.
   */
  sourceLanguage?: LanguageCode;
  targetLanguage?: LanguageCode;
  port: number;
  /** 오버레이 검출/좌표 출력 방식 식별자. 언어 의미는 갖지 않는다. */
  promptMode: string;
  promptOverrideText?: string;
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;
  ctx: number;
  /** User default formatting applied to blocks created from this run. */
  blockFormatDefaults?: BlockFormatDefaults;
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
  unifiedMemoryMb?: number;
  allowUnsafeUnifiedMemory?: boolean;
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
  apiKeyMaxAttempts?: number;
  apiRetryDelaySeconds?: number;
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
  ocrBboxMode?: string;
  ocrEngine?: string;
  ocrEngineDtype?: string;
  ocrVersion?: string;
  ocrTextDetectionModelName?: string;
  ocrTextRecognitionModelName?: string;
  ocrMergeMode?: string;
  ocrDetLimit?: string;
  ocrRecBatch?: string;
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
  regionContextImagePath?: string;
  regionContextImageWidth?: number;
  regionContextImageHeight?: number;
  regionContextCropRect?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
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
  workContextBudget?: WorkContextBudgetPlan;
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
