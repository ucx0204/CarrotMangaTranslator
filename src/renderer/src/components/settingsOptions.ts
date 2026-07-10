import type {
  ApiReasoningEffort,
  CodexReasoningEffort,
  FluxBackend,
  LlamaRuntimeProfile,
  InpaintingModel,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../../shared/settingsTypes";
import {
  CODEX_MODEL_PRESETS,
  GEMMA_MODEL_PRESETS,
  type CodexModelPreset,
  type GemmaModelPresetId,
} from "../../../shared/modelPresets";

export {
  DEFAULT_GEMMA_MMPROJ_FILE,
  DEFAULT_GEMMA_MMPROJ_REPO,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
  MIN_CONTEXT_TOKENS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
} from "../../../shared/modelPresets";

const MODEL_PRESET_COPY: Record<
  GemmaModelPresetId,
  { label: string; description: string }
> = {
  minimum12b: {
    label: "12B 최소",
    description: "8GB급 VRAM용입니다. 실행 가능성과 가벼운 구동을 우선합니다.",
  },
  economy26b: {
    label: "26B 절약",
    description:
      "16GB급 VRAM용입니다. 이미지 토큰 1024는 유지하고 26B 모델로 더 안전하게 실행합니다.",
  },
  full31b: {
    label: "31B 풀로드",
    description:
      "넉넉한 VRAM용입니다. 31B 모델과 DFlash를 사용해 품질 우선으로 실행합니다.",
  },
} as const;

export const MODEL_PRESETS = {
  minimum12b: {
    ...GEMMA_MODEL_PRESETS.minimum12b,
    ...MODEL_PRESET_COPY.minimum12b,
  },
  economy26b: {
    ...GEMMA_MODEL_PRESETS.economy26b,
    ...MODEL_PRESET_COPY.economy26b,
  },
  full31b: {
    ...GEMMA_MODEL_PRESETS.full31b,
    ...MODEL_PRESET_COPY.full31b,
  },
} as const;
export const DEFAULT_MODEL_PRESET_ID: GemmaModelPresetId = "full31b";

export type ModelPresetId = keyof typeof MODEL_PRESETS | "custom";

type ModelSourceOption = {
  id: ModelSource;
  label: string;
  description: string;
};

type ModelProviderOption = {
  id: ModelProvider;
  label: string;
  description: string;
};

type CodexReasoningOption = {
  id: CodexReasoningEffort;
  label: string;
  description: string;
};

export type CodexModelOption = CodexModelPreset;

export const CODEX_MODEL_OPTIONS: readonly CodexModelOption[] =
  CODEX_MODEL_PRESETS;

type ApiReasoningOption = {
  id: ApiReasoningEffort | "";
  label: string;
};

export type OcrRuntimeOptionId = OcrGpuBackend | "cpu";

type OcrDeviceOption = {
  id: OcrRuntimeOptionId;
  label: string;
  description: string;
  device: OcrDevice;
  gpuBackend?: OcrGpuBackend;
};

type OcrQualityOption = {
  id: OcrQualityMode;
  label: string;
  description: string;
};

type LlamaRuntimeProfileOption = {
  id: LlamaRuntimeProfile;
  label: string;
  description: string;
};

type FluxBackendOption = {
  id: FluxBackend;
  label: string;
  description: string;
};

type InpaintingModelOption = {
  id: InpaintingModel;
  label: string;
  description: string;
};

export const MODEL_SOURCE_OPTIONS: ModelSourceOption[] = [
  {
    id: "huggingface",
    label: "HF repo",
    description: "기본 프리셋이나 Hugging Face repo/GGUF 파일명을 사용합니다.",
  },
  {
    id: "local",
    label: "로컬 파일",
    description: "이미 가지고 있는 GGUF 모델과 mmproj를 직접 지정합니다.",
  },
];

export const MODEL_PROVIDER_OPTIONS: ModelProviderOption[] = [
  {
    id: "gemma",
    label: "Gemma 4",
    description: "로컬 llama-server로 Gemma 4 비전 모델을 실행합니다.",
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    description:
      "Codex 로그인 토큰을 쓰는 openai-oauth 엔드포인트로 요청합니다.",
  },
  {
    id: "openai-api",
    label: "API",
    description: "OpenAI 호환 /chat/completions API 엔드포인트로 요청합니다.",
  },
];

export const CODEX_REASONING_OPTIONS: CodexReasoningOption[] = [
  {
    id: "none",
    label: "없음",
    description: "생각 예산을 쓰지 않고 가장 빠르게 응답합니다.",
  },
  {
    id: "low",
    label: "낮음",
    description: "가벼운 추론으로 처리합니다.",
  },
  {
    id: "medium",
    label: "보통",
    description: "기본 균형 설정입니다.",
  },
  {
    id: "high",
    label: "높음",
    description: "더 오래 생각해서 까다로운 페이지를 처리합니다.",
  },
  {
    id: "xhigh",
    label: "매우 높음",
    description: "high보다 더 넉넉한 생각 예산을 사용합니다.",
  },
  {
    id: "max",
    label: "최대",
    description: "지원 모델에서 xhigh보다 더 큰 생각 예산을 사용합니다.",
  },
  {
    id: "ultra",
    label: "Ultra",
    description: "지원 모델에서 가장 큰 Ultra 생각 예산을 사용합니다.",
  },
];

export function findCodexModelOption(
  model: string,
): CodexModelOption | undefined {
  const normalized = model.trim();
  return CODEX_MODEL_OPTIONS.find((option) => option.id === normalized);
}

export function supportsCodexReasoningEffort(
  model: CodexModelOption,
  effort: CodexReasoningEffort,
): boolean {
  return model.reasoningEfforts.some((candidate) => candidate === effort);
}

export function resolveCodexReasoningEffortForModel(
  model: string,
  effort: CodexReasoningEffort,
): CodexReasoningEffort {
  const option = findCodexModelOption(model);
  return option && !supportsCodexReasoningEffort(option, effort)
    ? option.defaultReasoningEffort
    : effort;
}

export const API_REASONING_OPTIONS: ApiReasoningOption[] = [
  { id: "", label: "보내지 않음" },
  { id: "none", label: "none" },
  { id: "minimal", label: "minimal" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
];

export const OCR_DEVICE_OPTIONS: OcrDeviceOption[] = [
  {
    id: "cuda",
    label: "NVIDIA CUDA",
    description:
      "NVIDIA GPU에서 PaddlePaddle CUDA + PaddleOCRVL로 OCR을 실행합니다.",
    device: "gpu",
    gpuBackend: "cuda",
  },
  {
    id: "rocm-transformers",
    label: "AMD ROCm",
    description:
      "지원되는 Windows ROCm GPU에서 PyTorch ROCm + PaddleOCR Transformers engine으로 OCR을 실행합니다.",
    device: "gpu",
    gpuBackend: "rocm-transformers",
  },
  {
    id: "cpu",
    label: "CPU",
    description:
      "느리지만 별도 GPU OCR 런타임 없이 가장 안정적으로 동작합니다.",
    device: "cpu",
  },
];

export const OCR_QUALITY_OPTIONS: OcrQualityOption[] = [
  {
    id: "minimum",
    label: "최소",
    description:
      "PP-OCRv6 small detector + tiny recognizer 조합입니다. 선택하면 OCR 장치를 CPU로 전환합니다.",
  },
  {
    id: "economy",
    label: "절약",
    description:
      "PP-OCRv6 small detector + small recognizer 조합입니다. 선택하면 OCR 장치를 CPU로 전환합니다.",
  },
  {
    id: "full",
    label: "풀로드",
    description:
      "PaddleOCR-VL 기본 경로를 사용합니다. 선택하면 OCR 장치를 GPU로 전환하며, CPU에서는 너무 느려 사용할 수 없습니다(장치를 CPU로 바꾸면 절약 품질로 전환됩니다).",
  },
];

export const LLAMA_RUNTIME_PROFILE_OPTIONS: LlamaRuntimeProfileOption[] = [
  {
    id: "cuda12",
    label: "CUDA 12",
    description: "RTX 20/30/40 등 기존 NVIDIA GPU용 런타임입니다.",
  },
  {
    id: "rtx50",
    label: "RTX 50",
    description: "RTX 50번대/Blackwell용 CUDA 13 계열 런타임입니다.",
  },
  {
    id: "vulkan",
    label: "AMD Vulkan",
    description:
      "ROCm 대상 확인이 안 되는 AMD GPU에서 쓰는 예비 llama.cpp Vulkan 런타임입니다.",
  },
  {
    id: "rocm",
    label: "AMD ROCm",
    description:
      "Windows AMD ROCm/HIP llama.cpp 런타임입니다. 지원되는 Radeon 아키텍처에서는 이 경로를 우선 사용합니다.",
  },
];

export const FLUX_BACKEND_OPTIONS: FluxBackendOption[] = [
  {
    id: "cuda-native",
    label: "NVIDIA CUDA",
    description:
      "기존 Flux Klein 네이티브 런타임입니다. RTX 계열에서는 이 경로가 가장 빠릅니다.",
  },
  {
    id: "zluda-native",
    label: "AMD ZLUDA",
    description:
      "AMD GPU에서 NVIDIA와 같은 Flux Klein/Candle 실행기를 ZLUDA로 실행합니다. AMD HIP SDK가 필요합니다.",
  },
  {
    id: "python-cpu",
    label: "CPU",
    description:
      "GPU 런타임이 맞지 않는 환경에서 직접 선택하는 CPU 호환 모드입니다. 처리 속도는 많이 느립니다.",
  },
];

export const INPAINTING_MODEL_OPTIONS: InpaintingModelOption[] = [
  {
    id: "aot-inpainting",
    label: "AOT 최소",
    description:
      "가장 가벼운 Koharu AOT 인페인팅입니다. 실행 가능성과 낮은 사용량을 우선합니다.",
  },
  {
    id: "lama-manga",
    label: "LaMa 절약",
    description:
      "Koharu의 manga 특화 LaMa 인페인팅입니다. 말풍선/작은 글자 제거를 빠르고 가볍게 처리합니다.",
  },
  {
    id: "flux-klein",
    label: "Flux 풀로드",
    description:
      "기본 인페인팅 모델입니다. 품질 우선이며 기존 CUDA/ZLUDA/CPU Flux 백엔드를 그대로 사용합니다.",
  },
];

export function resolveModelPreset(
  modelRepo: string,
  modelFile: string,
): ModelPresetId {
  const trimmedModelRepo = modelRepo.trim();
  const trimmedModelFile = modelFile.trim();

  for (const [presetId, preset] of Object.entries(MODEL_PRESETS) as Array<
    [
      keyof typeof MODEL_PRESETS,
      (typeof MODEL_PRESETS)[keyof typeof MODEL_PRESETS],
    ]
  >) {
    if (matchesPreset(preset, trimmedModelRepo, trimmedModelFile)) {
      return presetId;
    }
  }

  return "custom";
}

function matchesPreset(
  preset: (typeof MODEL_PRESETS)[keyof typeof MODEL_PRESETS],
  modelRepo: string,
  modelFile: string,
): boolean {
  return preset.modelRepo === modelRepo && preset.modelFile === modelFile;
}
