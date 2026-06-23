import type {
  FluxBackend,
  InpaintingModel,
  KoharuInpaintingBackend,
} from "./inpaintingSettingsTypes";

export type {
  FluxBackend,
  InpaintingModel,
  KoharuInpaintingBackend,
} from "./inpaintingSettingsTypes";

export type ModelProvider = "gemma" | "openai-codex" | "openai-api";
export type ModelSource = "huggingface" | "local";
export type GemmaVramMode = "minimum12b" | "economy26b" | "full31b";
export type CodexReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type ApiReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type OcrDevice = "cpu" | "gpu";
export type OcrGpuBackend = "cuda" | "rocm-transformers";
export type LlamaRuntimeProfile = "cuda12" | "rtx50" | "rocm" | "vulkan";
export type AmdRocmTarget =
  | "gfx908"
  | "gfx90a"
  | "gfx103X"
  | "gfx110X"
  | "gfx1150"
  | "gfx1151"
  | "gfx120X";
export type RuntimeGpuVendor = "nvidia" | "amd" | "unknown";

export type RuntimeHardwareInfo = {
  gpuVendor: RuntimeGpuVendor;
  gpuName?: string | null;
  llamaRocmTarget?: AmdRocmTarget | null;
  supportsRocm?: boolean;
  supportsVulkan?: boolean;
};

export type GemmaSettings = {
  modelSource: ModelSource;
  modelRepo: string;
  modelFile: string;
  mmprojRepo?: string;
  mmprojFile?: string;
  localModelPath?: string;
  localMmprojPath?: string;
  vramMode: GemmaVramMode;
  llamaRuntimeProfile?: LlamaRuntimeProfile;
  llamaRocmTarget?: AmdRocmTarget;
};

export type CodexSettings = {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  oauthPort: number;
};

export type ApiSettings = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  reasoningEffort?: ApiReasoningEffort | null;
  extraBodyJson?: string;
  customHeadersJson?: string;
};

export type OcrSettings = {
  device: OcrDevice;
  gpuCudaTag?: string;
  gpuBackend?: OcrGpuBackend;
};

export type UiSettings = {
  inpaintingGuideHidden?: boolean;
  /** Default for the "2차 번역(품질 향상)" checkbox in the translate options modal. */
  twoPassByDefault?: boolean;
  /** Default AI 분석 범위 for the 2-pass flow. Mirrors WorkContextAnalysisScope. */
  analysisScopeDefault?: "work" | "missing" | "chapter";
};

export type InpaintingSettings = {
  model?: InpaintingModel;
  fluxBackend?: FluxBackend;
  koharuBackend?: KoharuInpaintingBackend;
};

export type AppSettings = {
  modelProvider: ModelProvider;
  gemma: GemmaSettings;
  codex: CodexSettings;
  api: ApiSettings;
  ocr: OcrSettings;
  ui?: UiSettings;
  inpainting?: InpaintingSettings;
  runtimeHardware?: RuntimeHardwareInfo;
  maxTokens: number;
  ctx: number;
};
