import { DEFAULT_INPAINTING_MODEL } from "../../../../shared/inpaintingSettingsTypes";
import type { GraphicsGpuPreference } from "../../../../shared/gpuSettings";
import { resolveRecommendedOcrQualityMode } from "../../../../shared/ocrMemoryPolicy";
import {
  resolveDefaultFluxMode,
  resolveDefaultFluxNvidiaBackend,
} from "../../../../shared/fluxHardwarePolicy";
import type {
  FluxBackend,
  FluxMode,
  InpaintingModel,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../../../shared/settingsTypes";

export type HardwareRecommendationInput = {
  unifiedMemoryMb: number | null;
  gpuMemoryMb?: number | null;
  usesAmdHardware: boolean;
  usesAppleHardware: boolean;
  supportsQwenMetal?: boolean;
  usesNvidiaHardware: boolean;
  usesSm75Hardware?: boolean;
  computeCapability?: number | null;
  rtxGeneration?: number | null;
  supportsOcrRocm?: boolean;
  supportsFluxZluda?: boolean;
  supportsQwenRocm?: boolean;
};

export type HardwareRecommendation = {
  fluxBackend: FluxBackend;
  fluxMode: FluxMode;
  graphicsGpuPreference: GraphicsGpuPreference;
  inpaintingModel: InpaintingModel;
  ocrDevice: OcrDevice;
  ocrGpuBackend: OcrGpuBackend;
  ocrQualityMode: OcrQualityMode;
};

export function resolveHardwareRecommendation(
  props: HardwareRecommendationInput,
): HardwareRecommendation {
  if (props.usesAppleHardware) {
    return {
      fluxBackend: "metal-native",
      fluxMode: "normal",
      graphicsGpuPreference: "auto",
      inpaintingModel:
        (props.unifiedMemoryMb ?? 0) < 16 * 1024
          ? "lama-manga"
          : props.supportsQwenMetal === false
            ? "flux-klein"
            : DEFAULT_INPAINTING_MODEL,
      ocrDevice: "cpu",
      ocrGpuBackend: "cuda",
      ocrQualityMode: "economy",
    };
  }
  if (props.usesNvidiaHardware) {
    return createGpuRecommendation(
      props,
      "cuda",
      resolveDefaultFluxNvidiaBackend(props),
    );
  }
  if (props.usesAmdHardware) {
    const recommendation = createGpuRecommendation(
      props,
      "rocm-transformers",
      (props.supportsQwenRocm ?? props.supportsFluxZluda) === true
        ? "rocm-native"
        : "vulkan-native",
    );
    return props.supportsOcrRocm === true
      ? recommendation
      : {
          ...recommendation,
          ocrDevice: "cpu",
          ocrGpuBackend: "cuda",
          ocrQualityMode: "economy",
        };
  }
  return {
    fluxBackend: "cpu-native",
    fluxMode: "normal",
    graphicsGpuPreference: "auto",
    inpaintingModel: "aot-inpainting",
    ocrDevice: "cpu",
    ocrGpuBackend: "cuda",
    ocrQualityMode: "economy",
  };
}

function createGpuRecommendation(
  props: HardwareRecommendationInput,
  ocrGpuBackend: OcrGpuBackend,
  fluxBackend: FluxBackend,
): HardwareRecommendation {
  const ocrDevice = "gpu" as const;
  return {
    fluxBackend,
    fluxMode: resolveDefaultFluxMode(props.usesAmdHardware, props.gpuMemoryMb),
    graphicsGpuPreference: "high-performance",
    inpaintingModel:
      fluxBackend === "cpu-native"
        ? "aot-inpainting"
        : DEFAULT_INPAINTING_MODEL,
    ocrDevice,
    ocrGpuBackend,
    ocrQualityMode: resolveRecommendedOcrQualityMode({
      ocrDevice,
      gpuMemoryMb: props.gpuMemoryMb,
    }),
  };
}
