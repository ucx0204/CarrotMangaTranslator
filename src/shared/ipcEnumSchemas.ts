import { z } from "zod";
import {
  canonicalizeAmdRocmTarget,
  canonicalizeFluxBackend,
  canonicalizeGemmaVramMode,
  canonicalizeInpaintingModel,
  canonicalizeKoharuInpaintingBackend,
  canonicalizeLlamaRuntimeProfile,
  canonicalizeOcrGpuBackend,
  canonicalizeOcrQualityMode,
} from "./settingsAliasCanonicalizers";

export const GemmaVramModeSchema = z.preprocess(
  (value) => canonicalizeGemmaVramMode(value) ?? value,
  z.enum(["minimum12b", "economy26b", "full31b"]),
);

export const LlamaRuntimeProfileSchema = z.preprocess(
  (value) => canonicalizeLlamaRuntimeProfile(value) ?? value,
  z.enum(["cuda12", "rtx50", "rocm", "vulkan", "metal"]),
);

export const AmdRocmTargetSchema = z.preprocess(
  (value) => canonicalizeAmdRocmTarget(value) ?? value,
  z.enum([
    "gfx908",
    "gfx90a",
    "gfx103X",
    "gfx110X",
    "gfx1150",
    "gfx1151",
    "gfx120X",
  ]),
);

export const FluxBackendSchema = z.preprocess(
  (value) => canonicalizeFluxBackend(value, "ipc") ?? value,
  z.enum([
    "cuda-native",
    "cuda-sm75-experimental",
    "zluda-native",
    "metal-native",
    "cpu-native",
  ]),
);

export const InpaintingModelSchema = z.preprocess(
  (value) => canonicalizeInpaintingModel(value, "ipc") ?? value,
  z.enum(["flux-klein", "lama-manga", "aot-inpainting"]),
);

export const KoharuInpaintingBackendSchema = z.preprocess(
  (value) => canonicalizeKoharuInpaintingBackend(value, "ipc") ?? value,
  z.enum(["auto", "cuda-native", "zluda-native", "metal-native", "cpu"]),
);

export const OcrGpuBackendSchema = z.preprocess(
  (value) => canonicalizeOcrGpuBackend(value, "ipc") ?? value,
  z.enum(["cuda", "rocm-transformers"]),
);

export const OcrQualityModeSchema = z.preprocess(
  (value) => canonicalizeOcrQualityMode(value) ?? value,
  z.enum(["economy", "full"]),
);
