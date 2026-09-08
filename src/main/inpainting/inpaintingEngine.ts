import type { InpaintingModel } from "../../shared/inpaintingSettingsTypes";
import type { PixelRect } from "./maskGeometry";
import type { CodexErasureTarget } from "../application/codexTypesettingContracts";

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

/** Native bitmap work owned by one Codex erasure invocation. */
export type CodexRepairRequest = {
  bitmap: Buffer;
  width: number;
  height: number;
  mask: Uint8Array;
  windows: PixelRect[];
  signal: AbortSignal;
  mode: "region" | "paint";
  paintedCore?: Uint8Array;
  feather: number;
  constraint?: Uint8Array;
  protectedMask?: Uint8Array;
  tileBounds?: PixelRect;
  targets?: CodexErasureTarget[];
};

type InpaintRunOptions = {
  sourceImagePath?: string;
  /** Actual decoded asset; existing inpainting remains distinct from its reviewed original. */
  inputImagePath?: string;
  decodeFallback?: (filePath: string) => Promise<Buffer | null>;
  /** A region authorizes text discovery; a painted mask authorizes those pixels only. */
  codexMaskMode?: "region" | "paint";
  codexTargets?: CodexErasureTarget[];
  signal?: AbortSignal;
  featherPx?: number;
  contextPx?: number;
  maskPaddingPx?: number;
  maxPixels?: number;
  bubbleMask?: Uint8Array;
  windowMasks?: InpaintingWindowMask[];
  /** Fully opaque output cores; windowMasks remain the broader model masks. */
  compositeMasks?: InpaintingWindowMask[];
  /** Per-window outward feather widths in source-page pixels. */
  compositeFeatherPx?: number[];
  /**
   * Optional per-window hard boundaries for the final composite. A null entry
   * keeps that window unconstrained.
   */
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  /** Fail fast when an engine can prove that every processed pixel is unchanged. */
  requirePixelChange?: boolean;
};

export type InpaintingEngine = {
  model: InpaintingModel | "codex";
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
