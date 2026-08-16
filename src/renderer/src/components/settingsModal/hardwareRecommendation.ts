import type { GraphicsGpuPreference } from "../../../../shared/gpuSettings";
import { resolveRecommendedOcrQualityMode } from "../../../../shared/ocrMemoryPolicy";
import type {
  FluxBackend,
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
  usesNvidiaHardware: boolean;
  usesSm75Hardware?: boolean;
  supportsOcrRocm?: boolean;
  supportsFluxZluda?: boolean;
};

export type HardwareRecommendation = {
  fluxBackend: FluxBackend;
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
      graphicsGpuPreference: "auto",
      inpaintingModel:
        (props.unifiedMemoryMb ?? 0) >= 16 * 1024 ? "flux-klein" : "lama-manga",
      ocrDevice: "cpu",
      ocrGpuBackend: "cuda",
      ocrQualityMode: "economy",
    };
  }
  if (props.usesNvidiaHardware) {
    return createGpuRecommendation(
      props,
      "cuda",
      props.usesSm75Hardware ? "cuda-sm75-experimental" : "cuda-native",
    );
  }
  if (props.usesAmdHardware) {
    const recommendation = createGpuRecommendation(
      props,
      "rocm-transformers",
      props.supportsFluxZluda === false ? "python-cpu" : "zluda-native",
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
    fluxBackend: "python-cpu",
    graphicsGpuPreference: "auto",
    inpaintingModel: "lama-manga",
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
    graphicsGpuPreference: "high-performance",
    inpaintingModel: "flux-klein",
    ocrDevice,
    ocrGpuBackend,
    ocrQualityMode: resolveRecommendedOcrQualityMode({
      ocrDevice,
      gpuMemoryMb: props.gpuMemoryMb,
    }),
  };
}
