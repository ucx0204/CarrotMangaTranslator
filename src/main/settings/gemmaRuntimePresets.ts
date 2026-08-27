import type { GemmaVramMode } from "../../shared/settingsTypes";
import {
  DEFAULT_GEMMA_CONTEXT_TOKENS,
  DEFAULT_GEMMA_DRAFT_MODEL_FILE,
  DEFAULT_GEMMA_DRAFT_MODEL_REPO,
  GEMMA_12B_QAT_MTP_MODEL_FILE,
  GEMMA_12B_QAT_MTP_MODEL_REPO,
  GEMMA_26B_QAT_MTP_MODEL_FILE,
  GEMMA_26B_QAT_MTP_MODEL_REPO,
  GEMMA_31B_QAT_MTP_MODEL_FILE,
  GEMMA_31B_QAT_MTP_MODEL_REPO,
} from "../../shared/modelPresets";
import type {
  AppSettings,
  LlamaRuntimeProfile,
} from "../../shared/settingsTypes";
import {
  isQat12BGemmaModel,
  isQat26BGemmaModel,
  isQat31BGemmaModel,
} from "./gemmaModelPresets";

export const DEFAULT_IMAGE_TOKENS = 1024;
export const SPEED_GEMMA_FULL_GPU_THRESHOLDS_MB = {
  qat12b: 12 * 1024,
  qat26b: 24 * 1024,
  qat31b: 32 * 1024,
} as const;

type QatGemmaVariant = keyof typeof SPEED_GEMMA_FULL_GPU_THRESHOLDS_MB;

// Dedicated VRAM tools commonly report a few MiB below the nominal board
// capacity (for example, an RTX 4090 reports 24,564 MiB instead of 24,576).
const NOMINAL_GPU_MEMORY_TOLERANCE_MB = 128;

export type GemmaRuntimePreset = {
  ctx: number;
  ctxCap?: number;
  batch: number;
  ubatch: number;
  fitTargetMb: number;
  fitEnabled?: boolean;
  gpuLayers?: number | "fit" | "all";
  cacheTypeK?: string;
  cacheTypeV?: string;
  ctxCheckpoints?: number;
  kvOffload?: boolean;
  mmprojOffload?: boolean;
  disableMmap?: boolean;
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
  draftSpecType?: "dflash" | "draft-mtp";
  draftMaxTokens?: number;
  useDraft?: boolean;
};

export const GEMMA_RUNTIME_PRESETS: Record<GemmaVramMode, GemmaRuntimePreset> =
  {
    minimum12b: {
      ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
      batch: 1024,
      ubatch: 1024,
      fitTargetMb: 512,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      kvOffload: true,
      mmprojOffload: true,
      gpuLayers: "fit",
      enableMetrics: true,
      enablePerf: true,
      useDraft: false,
    },
    economy26b: {
      ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
      batch: 1024,
      ubatch: 1024,
      fitTargetMb: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      kvOffload: true,
      mmprojOffload: true,
      gpuLayers: "fit",
      enableMetrics: true,
      enablePerf: true,
      useDraft: false,
    },
    full31b: {
      ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
      batch: 1024,
      ubatch: 1024,
      fitTargetMb: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      kvOffload: true,
      mmprojOffload: true,
      enableMetrics: true,
      enablePerf: true,
      draftModelRepo: DEFAULT_GEMMA_DRAFT_MODEL_REPO,
      draftModelFile: DEFAULT_GEMMA_DRAFT_MODEL_FILE,
      draftSpecType: "dflash",
      useDraft: true,
    },
  };

export function resolveModelSpecificGemmaRuntimePreset(
  preset: GemmaRuntimePreset,
  gemma: AppSettings["gemma"],
  llamaRuntimeProfile: LlamaRuntimeProfile = "cuda12",
  gpuMemoryMb?: number | null,
): GemmaRuntimePreset {
  if (gemma.modelSource !== "huggingface") {
    return preset;
  }
  const variant = resolveQatGemmaVariant(gemma);
  if (!variant) return preset;
  const fullGpuOverride = resolveSpeedGemmaFullGpuOverride({
    gpuMemoryMb,
    llamaRuntimeProfile,
    variant,
  });
  if (llamaRuntimeProfile !== "cuda12" && llamaRuntimeProfile !== "rtx50") {
    return { ...preset, ...fullGpuOverride, useDraft: false };
  }
  const mtpAsset = resolveQatGemmaMtpAsset(variant);
  return {
    ...preset,
    ...resolveQatGemmaCudaOverride(variant),
    draftModelRepo: mtpAsset.repo,
    draftModelFile: mtpAsset.file,
    draftSpecType: "draft-mtp",
    useDraft: true,
    ...fullGpuOverride,
  };
}

function resolveSpeedGemmaFullGpuOverride({
  gpuMemoryMb,
  llamaRuntimeProfile,
  variant,
}: {
  gpuMemoryMb?: number | null;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  variant: QatGemmaVariant;
}): Pick<GemmaRuntimePreset, "fitEnabled" | "gpuLayers"> {
  if (llamaRuntimeProfile === "metal") return {};
  const thresholdMb = SPEED_GEMMA_FULL_GPU_THRESHOLDS_MB[variant];
  if (
    typeof gpuMemoryMb !== "number" ||
    !Number.isFinite(gpuMemoryMb) ||
    gpuMemoryMb <= 0 ||
    gpuMemoryMb + NOMINAL_GPU_MEMORY_TOLERANCE_MB < thresholdMb
  ) {
    return {};
  }
  return { fitEnabled: false, gpuLayers: "all" };
}

function resolveQatGemmaVariant(
  gemma: AppSettings["gemma"],
): QatGemmaVariant | null {
  if (isQat12BGemmaModel(gemma)) return "qat12b";
  if (isQat26BGemmaModel(gemma)) return "qat26b";
  if (isQat31BGemmaModel(gemma)) return "qat31b";
  return null;
}

function resolveQatGemmaMtpAsset(variant: QatGemmaVariant): {
  repo: string;
  file: string;
} {
  if (variant === "qat12b") {
    return {
      repo: GEMMA_12B_QAT_MTP_MODEL_REPO,
      file: GEMMA_12B_QAT_MTP_MODEL_FILE,
    };
  }
  if (variant === "qat26b") {
    return {
      repo: GEMMA_26B_QAT_MTP_MODEL_REPO,
      file: GEMMA_26B_QAT_MTP_MODEL_FILE,
    };
  }
  return {
    repo: GEMMA_31B_QAT_MTP_MODEL_REPO,
    file: GEMMA_31B_QAT_MTP_MODEL_FILE,
  };
}

function resolveQatGemmaCudaOverride(
  variant: QatGemmaVariant,
): Partial<GemmaRuntimePreset> {
  if (variant === "qat12b") return { draftMaxTokens: 8 };
  const common: Partial<GemmaRuntimePreset> = {
    gpuLayers: "fit",
    cacheTypeK: "q4_0",
    cacheTypeV: "q4_0",
    ctxCheckpoints: 0,
    kvOffload: true,
    mmprojOffload: true,
    disableMmap: true,
    threads: 10,
    threadsBatch: 12,
    draftMaxTokens: 2,
  };
  if (variant === "qat26b") return common;
  return {
    ...common,
    ctx: 12_288,
    ctxCap: 12_288,
    batch: 1024,
    ubatch: 1024,
  };
}
