import type { CodexReasoningEffort, ModelProvider, ModelSource, OcrDevice } from "../../../shared/types";
import {
  GEMMA_MODEL_PRESETS,
  type GemmaModelPresetId
} from "../../../shared/modelPresets";

export {
  DEFAULT_GEMMA_MMPROJ_FILE,
  DEFAULT_GEMMA_MMPROJ_REPO,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS
} from "../../../shared/modelPresets";

const MODEL_PRESET_COPY: Record<GemmaModelPresetId, { label: string; description: string }> = {
  economy26b: {
    label: "26B 절약",
    description: "16GB급 VRAM용입니다. 이미지 토큰 1024는 유지하고 26B 모델로 더 안전하게 실행합니다."
  },
  full31b: {
    label: "31B 풀로드",
    description: "넉넉한 VRAM용입니다. 31B 모델과 DFlash를 사용해 품질 우선으로 실행합니다."
  }
} as const;

export const MODEL_PRESETS = {
  economy26b: {
    ...GEMMA_MODEL_PRESETS.economy26b,
    ...MODEL_PRESET_COPY.economy26b
  },
  full31b: {
    ...GEMMA_MODEL_PRESETS.full31b,
    ...MODEL_PRESET_COPY.full31b
  }
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

type OcrDeviceOption = {
  id: OcrDevice;
  label: string;
  description: string;
};

export const MODEL_SOURCE_OPTIONS: ModelSourceOption[] = [
  {
    id: "huggingface",
    label: "HF repo",
    description: "기본 프리셋이나 Hugging Face repo/GGUF 파일명을 사용합니다."
  },
  {
    id: "local",
    label: "로컬 파일",
    description: "이미 가지고 있는 GGUF 모델과 mmproj를 직접 지정합니다."
  }
];

export const MODEL_PROVIDER_OPTIONS: ModelProviderOption[] = [
  {
    id: "gemma",
    label: "Gemma 4",
    description: "로컬 llama-server로 Gemma 4 비전 모델을 실행합니다."
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    description: "Codex 로그인 토큰을 쓰는 openai-oauth 엔드포인트로 요청합니다."
  }
];

export const CODEX_REASONING_OPTIONS: CodexReasoningOption[] = [
  {
    id: "none",
    label: "없음",
    description: "생각 예산을 쓰지 않고 가장 빠르게 응답합니다."
  },
  {
    id: "low",
    label: "낮음",
    description: "가벼운 추론으로 처리합니다."
  },
  {
    id: "medium",
    label: "보통",
    description: "기본 균형 설정입니다."
  },
  {
    id: "high",
    label: "높음",
    description: "더 오래 생각해서 까다로운 페이지를 처리합니다."
  },
  {
    id: "xhigh",
    label: "최고",
    description: "가장 넉넉한 생각 예산을 사용합니다."
  }
];

export const OCR_DEVICE_OPTIONS: OcrDeviceOption[] = [
  {
    id: "cpu",
    label: "CPU",
    description: "기본값입니다. 느리지만 별도 GPU Paddle 런타임 없이 가장 안정적으로 동작합니다."
  },
  {
    id: "gpu",
    label: "GPU",
    description: "PaddleOCR를 GPU로 실행합니다. GPU용 Paddle 런타임/CUDA가 맞지 않으면 OCR 단계가 실패할 수 있습니다."
  }
];

export function resolveModelPreset(modelRepo: string, modelFile: string): ModelPresetId {
  const trimmedModelRepo = modelRepo.trim();
  const trimmedModelFile = modelFile.trim();

  for (const [presetId, preset] of Object.entries(MODEL_PRESETS) as Array<
    [keyof typeof MODEL_PRESETS, (typeof MODEL_PRESETS)[keyof typeof MODEL_PRESETS]]
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
  modelFile: string
): boolean {
  return preset.modelRepo === modelRepo && preset.modelFile === modelFile;
}
