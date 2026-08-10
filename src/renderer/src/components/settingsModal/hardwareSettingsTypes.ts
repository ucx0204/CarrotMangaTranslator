import type React from "react";
import type { GraphicsGpuPreference } from "../../../../shared/gpuSettings";
import type {
  FluxBackend,
  InpaintingModel,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../../../shared/settingsTypes";

export type HardwareSettingsPanelProps = {
  allowUnsafeLowMemoryFlux: boolean;
  clearTestState: () => void;
  computeGpuIndex: number | null;
  controlsBusy: boolean;
  detectedGpuName?: string | null;
  gpuMemoryMb?: number | null;
  fluxBackend: FluxBackend;
  graphicsGpuPreference: GraphicsGpuPreference;
  inpaintingModel: InpaintingModel;
  isFluxBackendOptionDisabled: (backend: FluxBackend) => boolean;
  ocrGpuBackend: OcrGpuBackend;
  ocrDevice: OcrDevice;
  ocrQualityMode: OcrQualityMode;
  setFluxBackend: React.Dispatch<React.SetStateAction<FluxBackend>>;
  setGraphicsGpuPreference: React.Dispatch<
    React.SetStateAction<GraphicsGpuPreference>
  >;
  setComputeGpuIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setAllowUnsafeLowMemoryFlux: React.Dispatch<React.SetStateAction<boolean>>;
  setInpaintingModel: React.Dispatch<React.SetStateAction<InpaintingModel>>;
  setOcrDevice: React.Dispatch<React.SetStateAction<OcrDevice>>;
  setOcrGpuBackend: React.Dispatch<React.SetStateAction<OcrGpuBackend>>;
  setOcrQualityMode: React.Dispatch<React.SetStateAction<OcrQualityMode>>;
  usesAmdHardware: boolean;
  usesAppleHardware: boolean;
  usesAmdOcrContext: boolean;
  usesNvidiaHardware: boolean;
  usesNvidiaOcrContext: boolean;
  usesSm75Hardware?: boolean;
  unifiedMemoryMb: number | null;
};
