import type { GemmaVramMode } from "../../shared/types";
import {
  DEFAULT_GEMMA_DRAFT_MODEL_FILE,
  DEFAULT_GEMMA_DRAFT_MODEL_REPO
} from "../../shared/modelPresets";

export const DEFAULT_IMAGE_TOKENS = 1024;

export type GemmaRuntimePreset = {
  ctx: number;
  batch: number;
  ubatch: number;
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
};

export const GEMMA_RUNTIME_PRESETS: Record<GemmaVramMode, GemmaRuntimePreset> = {
  full: {
    ctx: 8192,
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
    useDraft: true
  },
  economy: {
    ctx: 8192,
    batch: 1024,
    ubatch: 1024,
    fitTargetMb: 2048,
    cacheTypeK: "q4_0",
    cacheTypeV: "q4_0",
    ctxCheckpoints: 0,
    kvOffload: true,
    mmprojOffload: true,
    gpuLayers: "fit",
    enableMetrics: true,
    enablePerf: true,
    useDraft: false
  }
};
