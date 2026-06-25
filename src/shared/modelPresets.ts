import type {
  ApiReasoningEffort,
  CodexReasoningEffort,
  GemmaVramMode,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrQualityMode,
} from "./types";

export const GEMMA_31B_MODEL_REPO =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
export const GEMMA_31B_MODEL_FILE_IQ3_S =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf";
export const GEMMA_31B_MMPROJ_REPO =
  "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
export const GEMMA_31B_MMPROJ_FILE =
  "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";

export const GEMMA_26B_MODEL_REPO =
  "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-i1-GGUF";
export const GEMMA_26B_MODEL_FILE_IQ3_S =
  "gemma-4-26B-A4B-it-ultra-uncensored-heretic.i1-IQ3_S.gguf";
export const GEMMA_26B_MMPROJ_REPO =
  "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF";
export const GEMMA_26B_MMPROJ_FILE =
  "gemma-4-26B-A4B-it-ultra-uncensored-heretic.mmproj-Q8_0.gguf";

export const GEMMA_12B_MODEL_REPO =
  "culturerevolt/gemma-4-12b-heretic-abliterated-GGUF";
export const GEMMA_12B_MODEL_FILE_Q4_K_M = "gemma-4-12b-heretic-Q4_K_M.gguf";
export const GEMMA_12B_MMPROJ_REPO = "ggml-org/gemma-4-12B-it-GGUF";
export const GEMMA_12B_MMPROJ_FILE = "mmproj-gemma-4-12B-it-bf16.gguf";

export const DEFAULT_GEMMA_MODEL_REPO = GEMMA_31B_MODEL_REPO;
export const DEFAULT_GEMMA_MODEL_FILE_IQ3_S = GEMMA_31B_MODEL_FILE_IQ3_S;
export const DEFAULT_GEMMA_MODEL_FILE = DEFAULT_GEMMA_MODEL_FILE_IQ3_S;
export const DEFAULT_GEMMA_MMPROJ_REPO = GEMMA_31B_MMPROJ_REPO;
export const DEFAULT_GEMMA_MMPROJ_FILE = GEMMA_31B_MMPROJ_FILE;
export const DEFAULT_GEMMA_DRAFT_MODEL_REPO =
  "Anbeeld/gemma-4-31B-it-DFlash-GGUF";
export const DEFAULT_GEMMA_DRAFT_MODEL_FILE =
  "gemma4-31b-it-dflash-IQ4_XS.gguf";

export const DEFAULT_GEMMA_VRAM_MODE: GemmaVramMode = "full31b";
export const DEFAULT_MODEL_PROVIDER: ModelProvider = "gemma";
export const DEFAULT_MODEL_SOURCE: ModelSource = "huggingface";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "low";
export const DEFAULT_CODEX_OAUTH_PORT = 10531;
export const DEFAULT_API_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_API_MODEL = DEFAULT_CODEX_MODEL;
export const DEFAULT_API_TEMPERATURE = 0.2;
export const DEFAULT_API_TOP_P = 0.95;
export const DEFAULT_API_TOP_K: number | null = null;
export const DEFAULT_API_REASONING_EFFORT: ApiReasoningEffort | null = null;
export const DEFAULT_API_EXTRA_BODY_JSON = "";
export const DEFAULT_API_CUSTOM_HEADERS_JSON = "";
export const DEFAULT_MAX_TOKENS = 12000;
export const MIN_MAX_TOKENS = 300;
export const MAX_MAX_TOKENS = 32768;
export const DEFAULT_CONTEXT_TOKENS = 16384;
export const MIN_CONTEXT_TOKENS = 1024;
export const DEFAULT_OCR_DEVICE: OcrDevice = "cpu";
export const DEFAULT_OCR_QUALITY_MODE: OcrQualityMode = "minimum";
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
  economy26b: {
    vramMode: "economy26b" as GemmaVramMode,
    modelRepo: GEMMA_26B_MODEL_REPO,
    modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    mmprojRepo: GEMMA_26B_MMPROJ_REPO,
    mmprojFile: GEMMA_26B_MMPROJ_FILE,
  },
  full31b: {
    vramMode: "full31b" as GemmaVramMode,
    modelRepo: GEMMA_31B_MODEL_REPO,
    modelFile: GEMMA_31B_MODEL_FILE_IQ3_S,
    mmprojRepo: GEMMA_31B_MMPROJ_REPO,
    mmprojFile: GEMMA_31B_MMPROJ_FILE,
  },
} as const;

export type GemmaModelPresetId = keyof typeof GEMMA_MODEL_PRESETS;
