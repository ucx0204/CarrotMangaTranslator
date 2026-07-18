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
  MIN_CONTEXT_TOKENS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
} from "../../../shared/modelPresets";

const MODEL_PRESET_COPY: Record<
  GemmaModelPresetId,
  { labelKey: string; descriptionKey: string }
> = {
  minimum12b: {
    labelKey: "settings.options.modelPresets.minimum12b.label",
    descriptionKey: "settings.options.modelPresets.minimum12b.description",
  },
  economy26b: {
    labelKey: "settings.options.modelPresets.economy26b.label",
    descriptionKey: "settings.options.modelPresets.economy26b.description",
  },
  full31b: {
    labelKey: "settings.options.modelPresets.full31b.label",
    descriptionKey: "settings.options.modelPresets.full31b.description",
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
export type ModelPresetId = keyof typeof MODEL_PRESETS | "custom";

type ModelSourceOption = {
  id: ModelSource;
  labelKey: string;
  descriptionKey: string;
};

type ModelProviderOption = {
  id: ModelProvider;
  labelKey: string;
  descriptionKey: string;
};

type CodexReasoningOption = {
  id: CodexReasoningEffort;
  labelKey: string;
  descriptionKey: string;
};

export type CodexModelOption = CodexModelPreset;

export const CODEX_MODEL_OPTIONS: readonly CodexModelOption[] =
  CODEX_MODEL_PRESETS;

type ApiReasoningOption = {
  id: ApiReasoningEffort | "";
  labelKey: string;
};

type OcrRuntimeOptionId = OcrGpuBackend | "cpu";

type OcrDeviceOption = {
  id: OcrRuntimeOptionId;
  labelKey: string;
  descriptionKey: string;
  device: OcrDevice;
  gpuBackend?: OcrGpuBackend;
};

type OcrQualityOption = {
  id: OcrQualityMode;
  labelKey: string;
  descriptionKey: string;
};

type LlamaRuntimeProfileOption = {
  id: LlamaRuntimeProfile;
  labelKey: string;
  descriptionKey: string;
};

type FluxBackendOption = {
  id: FluxBackend;
  labelKey: string;
  descriptionKey: string;
};

type InpaintingModelOption = {
  id: InpaintingModel;
  labelKey: string;
  descriptionKey: string;
};

export const MODEL_SOURCE_OPTIONS: ModelSourceOption[] = [
  {
    id: "huggingface",
    labelKey: "settings.options.modelSources.huggingface.label",
    descriptionKey: "settings.options.modelSources.huggingface.description",
  },
  {
    id: "local",
    labelKey: "settings.options.modelSources.local.label",
    descriptionKey: "settings.options.modelSources.local.description",
  },
];

export const MODEL_PROVIDER_OPTIONS: ModelProviderOption[] = [
  {
    id: "gemma",
    labelKey: "settings.options.providers.gemma.label",
    descriptionKey: "settings.options.providers.gemma.description",
  },
  {
    id: "openai-codex",
    labelKey: "settings.options.providers.codex.label",
    descriptionKey: "settings.options.providers.codex.description",
  },
  {
    id: "openai-api",
    labelKey: "settings.options.providers.api.label",
    descriptionKey: "settings.options.providers.api.description",
  },
];

export const CODEX_REASONING_OPTIONS: CodexReasoningOption[] = [
  {
    id: "none",
    labelKey: "settings.options.reasoning.none.label",
    descriptionKey: "settings.options.reasoning.none.description",
  },
  {
    id: "low",
    labelKey: "settings.options.reasoning.low.label",
    descriptionKey: "settings.options.reasoning.low.description",
  },
  {
    id: "medium",
    labelKey: "settings.options.reasoning.medium.label",
    descriptionKey: "settings.options.reasoning.medium.description",
  },
  {
    id: "high",
    labelKey: "settings.options.reasoning.high.label",
    descriptionKey: "settings.options.reasoning.high.description",
  },
  {
    id: "xhigh",
    labelKey: "settings.options.reasoning.xhigh.label",
    descriptionKey: "settings.options.reasoning.xhigh.description",
  },
  {
    id: "max",
    labelKey: "settings.options.reasoning.max.label",
    descriptionKey: "settings.options.reasoning.max.description",
  },
  {
    id: "ultra",
    labelKey: "settings.options.reasoning.ultra.label",
    descriptionKey: "settings.options.reasoning.ultra.description",
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
  { id: "", labelKey: "settings.options.apiReasoning.omit" },
  { id: "none", labelKey: "settings.options.apiReasoning.none" },
  { id: "minimal", labelKey: "settings.options.apiReasoning.minimal" },
  { id: "low", labelKey: "settings.options.apiReasoning.low" },
  { id: "medium", labelKey: "settings.options.apiReasoning.medium" },
  { id: "high", labelKey: "settings.options.apiReasoning.high" },
  { id: "xhigh", labelKey: "settings.options.apiReasoning.xhigh" },
];

export const OCR_DEVICE_OPTIONS: OcrDeviceOption[] = [
  {
    id: "cuda",
    labelKey: "settings.options.ocrDevices.cuda.label",
    descriptionKey: "settings.options.ocrDevices.cuda.description",
    device: "gpu",
    gpuBackend: "cuda",
  },
  {
    id: "rocm-transformers",
    labelKey: "settings.options.ocrDevices.rocm.label",
    descriptionKey: "settings.options.ocrDevices.rocm.description",
    device: "gpu",
    gpuBackend: "rocm-transformers",
  },
  {
    id: "cpu",
    labelKey: "settings.options.ocrDevices.cpu.label",
    descriptionKey: "settings.options.ocrDevices.cpu.description",
    device: "cpu",
  },
];

export const OCR_QUALITY_OPTIONS: OcrQualityOption[] = [
  {
    id: "minimum",
    labelKey: "settings.options.ocrQuality.minimum.label",
    descriptionKey: "settings.options.ocrQuality.minimum.description",
  },
  {
    id: "economy",
    labelKey: "settings.options.ocrQuality.economy.label",
    descriptionKey: "settings.options.ocrQuality.economy.description",
  },
  {
    id: "full",
    labelKey: "settings.options.ocrQuality.full.label",
    descriptionKey: "settings.options.ocrQuality.full.description",
  },
];

export const LLAMA_RUNTIME_PROFILE_OPTIONS: LlamaRuntimeProfileOption[] = [
  {
    id: "metal",
    labelKey: "settings.options.llamaRuntimes.metal.label",
    descriptionKey: "settings.options.llamaRuntimes.metal.description",
  },
  {
    id: "cuda12",
    labelKey: "settings.options.llamaRuntimes.cuda12.label",
    descriptionKey: "settings.options.llamaRuntimes.cuda12.description",
  },
  {
    id: "rtx50",
    labelKey: "settings.options.llamaRuntimes.rtx50.label",
    descriptionKey: "settings.options.llamaRuntimes.rtx50.description",
  },
  {
    id: "vulkan",
    labelKey: "settings.options.llamaRuntimes.vulkan.label",
    descriptionKey: "settings.options.llamaRuntimes.vulkan.description",
  },
  {
    id: "rocm",
    labelKey: "settings.options.llamaRuntimes.rocm.label",
    descriptionKey: "settings.options.llamaRuntimes.rocm.description",
  },
];

export const FLUX_BACKEND_OPTIONS: FluxBackendOption[] = [
  {
    id: "metal-native",
    labelKey: "settings.options.fluxBackends.metal.label",
    descriptionKey: "settings.options.fluxBackends.metal.description",
  },
  {
    id: "cuda-native",
    labelKey: "settings.options.fluxBackends.cuda.label",
    descriptionKey: "settings.options.fluxBackends.cuda.description",
  },
  {
    id: "zluda-native",
    labelKey: "settings.options.fluxBackends.zluda.label",
    descriptionKey: "settings.options.fluxBackends.zluda.description",
  },
  {
    id: "python-cpu",
    labelKey: "settings.options.fluxBackends.cpu.label",
    descriptionKey: "settings.options.fluxBackends.cpu.description",
  },
];

export const INPAINTING_MODEL_OPTIONS: InpaintingModelOption[] = [
  {
    id: "aot-inpainting",
    labelKey: "settings.options.inpaintingModels.aot.label",
    descriptionKey: "settings.options.inpaintingModels.aot.description",
  },
  {
    id: "lama-manga",
    labelKey: "settings.options.inpaintingModels.lama.label",
    descriptionKey: "settings.options.inpaintingModels.lama.description",
  },
  {
    id: "flux-klein",
    labelKey: "settings.options.inpaintingModels.flux.label",
    descriptionKey: "settings.options.inpaintingModels.flux.description",
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
