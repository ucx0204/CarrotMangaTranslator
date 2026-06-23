import type { InpaintingModel } from "../../shared/inpaintingSettingsTypes";
import type { PixelRect } from "./maskGeometry";

export type InpaintingRuntimeProgress = {
  progressText: string;
  detail?: string;
  progressMode?: "determinate" | "indeterminate" | "log-only";
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  installLogLine?: string;
};

type InpaintRunOptions = {
  signal?: AbortSignal;
  featherPx?: number;
  contextPx?: number;
  maskPaddingPx?: number;
  maxPixels?: number;
  bubbleMask?: Uint8Array;
};

export type InpaintingEngine = {
  model: InpaintingModel;
  runtimePath: string;
  modelPath?: string;
  backend: string;
  runRootDir: string;
  isHealthy?: () => boolean;
  inpaint: (
    bitmap: Buffer,
    width: number,
    height: number,
    mask: Uint8Array,
    windows: PixelRect[],
    options?: InpaintRunOptions,
  ) => Promise<void>;
  dispose: () => Promise<void>;
};
