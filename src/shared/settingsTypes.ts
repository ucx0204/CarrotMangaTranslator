import type {
  FluxBackend,
  InpaintingModel,
  KoharuInpaintingBackend,
} from "./inpaintingSettingsTypes";
import type { BlockFormatDefaults } from "./blockFormat";
import type { CodexReasoningEffort } from "./codexSettings";
import type { TranslationLanguageSettings } from "./translationLanguages";
import type { UiLocale } from "./uiLocales";
import type { KeybindingOverrides } from "./shortcutSettings";
import type { HardwareGpuSettings } from "./gpuSettings";
import type {
  BlockStylePreset,
  BlockStylePresetGroup,
} from "./blockStylePresets";

export type {
  FluxBackend,
  InpaintingModel,
  KoharuInpaintingBackend,
} from "./inpaintingSettingsTypes";
export type {
  BlockFormatDefaults,
  BlockFormatDirectionDefault,
} from "./blockFormat";
export type { CodexReasoningEffort } from "./codexSettings";
export type { LanguageCode } from "./translationLanguages";
export type { UiLocale } from "./uiLocales";

export type ModelProvider = "gemma" | "openai-codex" | "openai-api";
export type ModelSource = "huggingface" | "local";
export type GemmaVramMode = "minimum12b" | "economy26b" | "full31b";
export type ApiReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type OcrDevice = "cpu" | "gpu";
export type OcrGpuBackend = "cuda" | "rocm-transformers";
export type OcrQualityMode = "economy" | "full";
export type TranslationWorkflowMode = "standard" | "cumulative";
export type LlamaRuntimeProfile =
  | "cuda12"
  | "rtx50"
  | "rocm"
  | "vulkan"
  | "metal";
export type AmdRocmTarget =
  | "gfx908"
  | "gfx90a"
  | "gfx103X"
  | "gfx110X"
  | "gfx1150"
  | "gfx1151"
  | "gfx120X";
type RuntimeGpuVendor = "nvidia" | "amd" | "apple" | "unknown";

type RuntimeHardwareInfo = {
  gpuVendor: RuntimeGpuVendor;
  gpuName?: string | null;
  /** Dedicated GPU memory reported by the detected adapter. */
  gpuMemoryMb?: number | null;
  computeCapability?: number | null;
  rtxGeneration?: number | null;
  llamaRocmTarget?: AmdRocmTarget | null;
  /** Whether the detected AMD adapter is supported by the packaged ROCm OCR runtime. */
  supportsOcrRocm?: boolean;
  /** Whether AMD officially supports the adapter in the current Windows HIP SDK. */
  supportsFluxZluda?: boolean;
  supportsRocm?: boolean;
  supportsVulkan?: boolean;
  supportsMetal?: boolean;
  /** Apple Silicon shares this physical memory between CPU and GPU. */
  unifiedMemoryMb?: number | null;
};

type GemmaSettings = {
  modelSource: ModelSource;
  modelRepo: string;
  modelFile: string;
  mmprojRepo?: string;
  mmprojFile?: string;
  localModelPath?: string;
  localMmprojPath?: string;
  vramMode: GemmaVramMode;
  /** VRAM llama.cpp's automatic GPU fitting should leave available. */
  fitTargetMb?: number;
  /** Whether the multimodal projector is kept on the GPU. */
  mmprojOffload?: boolean;
  llamaRuntimeProfile?: LlamaRuntimeProfile;
  llamaRocmTarget?: AmdRocmTarget;
  /**
   * Apple Silicon Alpha only. The renderer must obtain explicit risk
   * confirmation before setting this when the selected model exceeds the
   * recommended unified-memory tier.
   */
  allowUnsafeUnifiedMemory?: boolean;
};

type CodexSettings = {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  oauthPort: number;
};

type ApiSettings = {
  baseUrl: string;
  model: string;
  /** Newline-delimited keys. A single legacy key remains valid. */
  apiKey?: string;
  /** Vertex only. The UI defaults new setups to service-account JSON. */
  vertexAuthMode?: import("./apiProviderPresets").VertexAuthMode;
  /** Local path only. The JSON credential contents are never copied to settings. */
  vertexServiceAccountPath?: string;
  keyMaxAttempts?: number;
  retryDelaySeconds?: number;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  reasoningEffort?: ApiReasoningEffort | null;
  extraBodyJson?: string;
  customHeadersJson?: string;
};

type OcrSettings = {
  device: OcrDevice;
  qualityMode: OcrQualityMode;
  gpuCudaTag?: string;
  gpuBackend?: OcrGpuBackend;
};

export type UiSettings = {
  /** Application interface language. Independent from the manga translation pair. */
  locale?: UiLocale;
  inpaintingGuideHidden?: boolean;
  /** Default translation workflow. Missing or unsupported values use cumulative. */
  translationWorkflowDefault?: TranslationWorkflowMode;
  /** Default 블록 mode for translate: auto-detect blocks or keep existing block regions. */
  blockModeDefault?: "auto" | "keep";
  /** Insert size-aware hard line breaks into newly translated block text. */
  naturalTextLayoutDefault?: boolean;
  /** Choose locale-compatible fonts for newly detected translation blocks. */
  autoFontMatchingDefault?: boolean;
  /** Match new block text size to source glyph pixels before box fitting. */
  fontSizeAutoFitDefault?: boolean;
  /** Erase source text with automatic inpainting after translation. */
  eraseOriginalWorkflowDefault?: boolean;
  /** Fit translated text to detected speech balloons after erasing. */
  bubbleLayoutWorkflowDefault?: boolean;
};

type InpaintingSettings = {
  model?: InpaintingModel;
  fluxBackend?: FluxBackend;
  koharuBackend?: KoharuInpaintingBackend;
  /** Explicit Alpha opt-in for Flux Metal below the recommended 16 GiB. */
  allowUnsafeLowMemoryFlux?: boolean;
  /** Run bubble-aware text placement after an inpainting result is created. */
  bubbleLayoutAfterInpainting?: boolean;
  /** Total fraction removed from each detected balloon text-region axis. */
  bubbleLayoutPaddingRatio?: number;
};

export type AppSettings = {
  modelProvider: ModelProvider;
  /** Persistent GPU routing preferences. Runtime-detected hardware is separate. */
  hardware?: HardwareGpuSettings;
  /**
   * 작품 번역 언어쌍(원문 -> 번역). 모델 제공자와 독립인 번역 도메인 설정.
   * 저장 설정에 없으면 normalize에서 일본어 -> 한국어로 채워진다.
   */
  translation?: TranslationLanguageSettings;
  gemma: GemmaSettings;
  codex: CodexSettings;
  api: ApiSettings;
  ocr: OcrSettings;
  ui?: UiSettings;
  inpainting?: InpaintingSettings;
  /** Default text-block formatting applied to newly created blocks. */
  blockFormatDefaults?: BlockFormatDefaults;
  /** Named, formatting-only presets shared across works. */
  blockStylePresets?: BlockStylePreset[];
  /** Optional two-level folders used to organize formatting presets. */
  blockStylePresetGroups?: BlockStylePresetGroup[];
  keybindings?: KeybindingOverrides;
  runtimeHardware?: RuntimeHardwareInfo;
  maxTokens: number;
  ctx: number;
};
