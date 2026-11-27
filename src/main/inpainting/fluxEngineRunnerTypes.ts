import type { FluxCropStrategy } from "./fluxCropTiling";
import type {
  FluxWorkerRequest,
  FluxWorkerCropResult,
  IllustratedTitleHint,
} from "./fluxWorkerTypes";
import type { FluxInpaintSummary } from "./fluxInpaintSummary";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { ExclusiveInpaintingWindowMasks } from "./inpaintingWindowMask";
import type { PixelRect } from "./maskGeometry";

export type FluxInpaintRunOptions = {
  signal?: AbortSignal;
  steps?: number;
  featherPx?: number;
  contextPx?: number;
  maskPaddingPx?: number;
  maxPixels?: number;
  windowMasks?: InpaintingWindowMask[];
  speechBubbleWindows?: boolean[];
  illustratedTitleWindows?: IllustratedTitleHint[];
  windowProcessingOrder?: readonly number[];
  compositeMasks?: InpaintingWindowMask[];
  compositeFeatherPx?: number[];
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  requirePixelChange?: boolean;
};

export type ResolvedFluxInpaintOptions = {
  contextPx: number;
  featherPx: number;
  maskPaddingPx: number;
  maxPixels: number;
};

export type FluxInpaintRunnerArgs = {
  bitmap: Buffer;
  getWorker: () => {
    inpaint(
      request: FluxWorkerRequest,
      signal?: AbortSignal,
    ): Promise<FluxWorkerCropResult>;
  };
  height: number;
  isolateWindowMasks: boolean;
  packLightWindows?: boolean;
  modelMaskIsTypography?: boolean;
  cropStrategy: FluxCropStrategy;
  mask: Uint8Array;
  runOptions: FluxInpaintRunOptions;
  runRootDir: string;
  width: number;
  windows: PixelRect[];
};

export type FluxInpaintDiagnostics = {
  warn: (message: string, detail?: unknown) => void;
};

export type FluxWindowProcessArgs = {
  bitmap: Buffer;
  sourceBitmap: Buffer;
  contextBitmap: Buffer;
  getWorker: FluxInpaintRunnerArgs["getWorker"];
  height: number;
  index: number;
  isolateWindowMasks: boolean;
  cropStrategy: FluxCropStrategy;
  mask: Uint8Array;
  options: ResolvedFluxInpaintOptions;
  runDir: string;
  runOptions: FluxInpaintRunOptions;
  compositeMasks?: InpaintingWindowMask[];
  windowMasks?: ExclusiveInpaintingWindowMasks[];
  width: number;
  window: PixelRect;
};

export type FluxWindowProcessResult =
  | { covered: boolean; eligible: false }
  | {
      eligible: true;
      unchanged: boolean;
      unchangedStats?: FluxInpaintSummary["unchangedStats"][number];
    };
