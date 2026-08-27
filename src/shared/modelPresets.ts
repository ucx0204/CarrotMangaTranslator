import type {
  ApiReasoningEffort,
  GemmaVramMode,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrQualityMode,
} from "./settingsTypes";
import type { CodexReasoningEffort } from "./codexSettings";

export const GEMMA_31B_MODEL_REPO =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
export const GEMMA_31B_MODEL_FILE_IQ3_S =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf";
export const GEMMA_31B_MMPROJ_REPO =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
export const GEMMA_31B_MMPROJ_FILE =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";

export const GEMMA_31B_QAT_MODEL_REPO =
  "HauhauCS/Gemma4-31B-QAT-Uncensored-HauhauCS-Balanced-MTP";
export const GEMMA_31B_QAT_MODEL_FILE_Q4_K_M =
  "Gemma4-31B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf";
export const GEMMA_31B_QAT_MMPROJ_REPO = GEMMA_31B_QAT_MODEL_REPO;
export const GEMMA_31B_QAT_MMPROJ_FILE =
  "mmproj-Gemma4-31B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf";
export const GEMMA_31B_QAT_MTP_MODEL_REPO = GEMMA_31B_QAT_MODEL_REPO;
export const GEMMA_31B_QAT_MTP_MODEL_FILE = "mtp-gemma-4-31B-it.gguf";

export const GEMMA_26B_MODEL_REPO =
  "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-i1-GGUF";
export const GEMMA_26B_MODEL_FILE_IQ3_S =
  "gemma-4-26B-A4B-it-ultra-uncensored-heretic.i1-IQ3_S.gguf";
export const GEMMA_26B_MMPROJ_REPO =
  "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF";
export const GEMMA_26B_MMPROJ_FILE =
  "gemma-4-26B-A4B-it-ultra-uncensored-heretic.mmproj-Q8_0.gguf";

export const GEMMA_26B_QAT_MODEL_REPO =
  "HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP";
export const GEMMA_26B_QAT_MODEL_FILE_Q4_K_M =
  "Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf";
export const GEMMA_26B_QAT_MMPROJ_REPO = GEMMA_26B_QAT_MODEL_REPO;
export const GEMMA_26B_QAT_MMPROJ_FILE =
  "mmproj-Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf";
export const GEMMA_26B_QAT_MTP_MODEL_REPO = GEMMA_26B_QAT_MODEL_REPO;
export const GEMMA_26B_QAT_MTP_MODEL_FILE = "mtp-gemma-4-26B-A4B-it.gguf";

export const GEMMA_12B_MODEL_REPO =
  "culturerevolt/gemma-4-12b-heretic-abliterated-GGUF";
export const GEMMA_12B_MODEL_FILE_Q4_K_M = "gemma-4-12b-heretic-Q4_K_M.gguf";
export const GEMMA_12B_MMPROJ_REPO = "ggml-org/gemma-4-12B-it-GGUF";
export const GEMMA_12B_MMPROJ_FILE = "mmproj-gemma-4-12B-it-BF16.gguf";

export const GEMMA_12B_QAT_MODEL_REPO =
  "HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced";
export const GEMMA_12B_QAT_MODEL_FILE_Q4_K_M =
  "Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf";
export const GEMMA_12B_QAT_MMPROJ_REPO = GEMMA_12B_QAT_MODEL_REPO;
export const GEMMA_12B_QAT_MMPROJ_FILE =
  "mmproj-Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf";
export const GEMMA_12B_QAT_MTP_MODEL_REPO = GEMMA_12B_QAT_MODEL_REPO;
export const GEMMA_12B_QAT_MTP_MODEL_FILE = "mtp-gemma-4-12B-it.gguf";

export const DEFAULT_GEMMA_MODEL_REPO = GEMMA_31B_MODEL_REPO;
export const DEFAULT_GEMMA_MODEL_FILE = GEMMA_31B_MODEL_FILE_IQ3_S;
export const DEFAULT_GEMMA_MMPROJ_REPO = GEMMA_31B_MMPROJ_REPO;
export const DEFAULT_GEMMA_MMPROJ_FILE = GEMMA_31B_MMPROJ_FILE;
export const DEFAULT_GEMMA_DRAFT_MODEL_REPO =
  "Anbeeld/gemma-4-31B-it-DFlash-GGUF";
export const DEFAULT_GEMMA_DRAFT_MODEL_FILE =
  "gemma4-31b-it-dflash-IQ4_XS.gguf";

export type CodexModelPreset = {
  id: string;
  label: string;
  defaultReasoningEffort: CodexReasoningEffort;
  reasoningEfforts: readonly CodexReasoningEffort[];
  /** Publicly documented model context window. */
  contextWindowTokens: number;
  /** Publicly documented output ceiling, or null when OpenAI does not publish one. */
  maxOutputTokens: number | null;
  /** App-level working default; intentionally lower than the model ceiling. */
  recommendedMaxTokens: number;
  /** Prompt-memory budget used by this app, not a server-side context setting. */
  recommendedContextTokens: number;
};

type ApiModelPreset = {
  id: string;
  /** Publicly documented model input/context ceiling. */
  contextWindowTokens: number;
  /** Publicly documented output ceiling. */
  maxOutputTokens: number;
  /** App-level working default, capped by the published output ceiling. */
  recommendedMaxTokens: number;
  /** Prompt-memory budget used by this app, not a server-side context setting. */
  recommendedContextTokens: number;
};

export const DEFAULT_REMOTE_MAX_TOKENS = 32768;
export const DEFAULT_REMOTE_CONTEXT_TOKENS = 65536;
export const DEFAULT_GEMMA_MAX_TOKENS = 32768;
export const DEFAULT_GEMMA_CONTEXT_TOKENS = 16384;

const API_MODEL_PRESETS = [
  {
    id: "gemini-3.5-flash-lite",
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    recommendedMaxTokens: 65_536,
    recommendedContextTokens: 524_288,
  },
] as const satisfies readonly ApiModelPreset[];

/** Fallback metadata for Codex models known to this app. */
export const CODEX_MODEL_PRESETS = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    defaultReasoningEffort: "low",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    recommendedMaxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6-Terra",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    recommendedMaxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6-Luna",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    recommendedMaxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    recommendedMaxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    recommendedMaxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    contextWindowTokens: 400000,
    maxOutputTokens: 128000,
    recommendedMaxTokens: DEFAULT_REMOTE_MAX_TOKENS,
    recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3-Codex-Spark",
    defaultReasoningEffort: "high",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    contextWindowTokens: 128000,
    maxOutputTokens: null,
    recommendedMaxTokens: 24576,
    recommendedContextTokens: DEFAULT_REMOTE_CONTEXT_TOKENS,
  },
] as const satisfies readonly CodexModelPreset[];

export type RecommendedGenerationLimits = {
  maxTokens: number;
  contextTokens: number;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
};

export function findCodexModelPreset(
  model: string | null | undefined,
): CodexModelPreset | undefined {
  const normalized = model?.trim();
  return CODEX_MODEL_PRESETS.find((preset) => preset.id === normalized);
}

function findApiModelPreset(
  model: string | null | undefined,
): ApiModelPreset | undefined {
  const normalized = model?.trim();
  return API_MODEL_PRESETS.find((preset) => preset.id === normalized);
}

export function resolveRecommendedGenerationLimits(
  provider: ModelProvider,
  model?: string | null,
): RecommendedGenerationLimits {
  if (provider === "gemma") {
    return {
      maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
      contextTokens: DEFAULT_GEMMA_CONTEXT_TOKENS,
      contextWindowTokens: null,
      maxOutputTokens: null,
    };
  }

  const preset =
    provider === "openai-codex"
      ? findCodexModelPreset(model)
      : findApiModelPreset(model);
  return {
    maxTokens: preset?.recommendedMaxTokens ?? DEFAULT_REMOTE_MAX_TOKENS,
    contextTokens:
      preset?.recommendedContextTokens ?? DEFAULT_REMOTE_CONTEXT_TOKENS,
    contextWindowTokens: preset?.contextWindowTokens ?? null,
    maxOutputTokens: preset?.maxOutputTokens ?? null,
  };
}

export const DEFAULT_MODEL_SOURCE: ModelSource = "huggingface";
export const DEFAULT_CODEX_MODEL = CODEX_MODEL_PRESETS[0].id;
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "low";
export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_API_MODEL = "gpt-5.5";
export const DEFAULT_API_TEMPERATURE = 0.2;
export const DEFAULT_API_TOP_P = 0.95;
export const DEFAULT_API_TOP_K: number | null = null;
export const DEFAULT_API_REASONING_EFFORT: ApiReasoningEffort | null = null;
export const DEFAULT_API_EXTRA_BODY_JSON = "";
export const DEFAULT_API_CUSTOM_HEADERS_JSON = "";
export const DEFAULT_MAX_TOKENS = DEFAULT_REMOTE_MAX_TOKENS;
export const MIN_MAX_TOKENS = 300;
export const MAX_MAX_TOKENS = 128000;
export const DEFAULT_CONTEXT_TOKENS = DEFAULT_REMOTE_CONTEXT_TOKENS;
export const MIN_CONTEXT_TOKENS = 1024;
export const DEFAULT_OCR_DEVICE: OcrDevice = "cpu";
export const DEFAULT_OCR_QUALITY_MODE: OcrQualityMode = "economy";
export const DEFAULT_OCR_GPU_CUDA_TAG = "cu126";
export const RTX_50_OCR_GPU_CUDA_TAG = "cu129";

export const GEMMA_MODEL_PRESETS = {
  minimum12b: {
    vramMode: "minimum12b" as GemmaVramMode,
    modelRepo: GEMMA_12B_MODEL_REPO,
    modelFile: GEMMA_12B_MODEL_FILE_Q4_K_M,
    mmprojRepo: GEMMA_12B_MMPROJ_REPO,
    mmprojFile: GEMMA_12B_MMPROJ_FILE,
  },
  qat12b: {
    vramMode: "minimum12b" as GemmaVramMode,
    modelRepo: GEMMA_12B_QAT_MODEL_REPO,
    modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
    mmprojRepo: GEMMA_12B_QAT_MMPROJ_REPO,
    mmprojFile: GEMMA_12B_QAT_MMPROJ_FILE,
  },
  economy26b: {
    vramMode: "economy26b" as GemmaVramMode,
    modelRepo: GEMMA_26B_MODEL_REPO,
    modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    mmprojRepo: GEMMA_26B_MMPROJ_REPO,
    mmprojFile: GEMMA_26B_MMPROJ_FILE,
  },
  qat26b: {
    vramMode: "economy26b" as GemmaVramMode,
    modelRepo: GEMMA_26B_QAT_MODEL_REPO,
    modelFile: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
    mmprojRepo: GEMMA_26B_QAT_MMPROJ_REPO,
    mmprojFile: GEMMA_26B_QAT_MMPROJ_FILE,
  },
  full31b: {
    vramMode: "full31b" as GemmaVramMode,
    modelRepo: GEMMA_31B_MODEL_REPO,
    modelFile: GEMMA_31B_MODEL_FILE_IQ3_S,
    mmprojRepo: GEMMA_31B_MMPROJ_REPO,
    mmprojFile: GEMMA_31B_MMPROJ_FILE,
  },
  qat31b: {
    vramMode: "full31b" as GemmaVramMode,
    modelRepo: GEMMA_31B_QAT_MODEL_REPO,
    modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
    mmprojRepo: GEMMA_31B_QAT_MMPROJ_REPO,
    mmprojFile: GEMMA_31B_QAT_MMPROJ_FILE,
  },
} as const;

export type GemmaModelPresetId = keyof typeof GEMMA_MODEL_PRESETS;
