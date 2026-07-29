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

export type InpaintingWindowMask = {
  bounds: PixelRect;
  data: Uint8Array;
};

type InpaintRunOptions = {
  signal?: AbortSignal;
  featherPx?: number;
  contextPx?: number;
  maskPaddingPx?: number;
  maxPixels?: number;
  bubbleMask?: Uint8Array;
  windowMasks?: InpaintingWindowMask[];
  /**
   * Optional per-window hard boundaries for the final composite. A null entry
   * keeps that window unconstrained.
   */
  compositeConstraints?: Array<InpaintingWindowMask | null>;
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
