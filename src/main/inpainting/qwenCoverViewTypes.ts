import type { NativeImage } from "electron";
import type { FluxWorkerRequest } from "./fluxWorkerTypes";
import type { QwenControlCrop } from "./qwenControlCrop";
type Size = { width: number; height: number };
export type QwenCoverViewOptions = {
  request: FluxWorkerRequest;
  source: NativeImage;
  stencil: Uint8Array;
  control: QwenControlCrop;
  decoded: Buffer;
  signal: AbortSignal;
  sizeFor: (width: number, height: number) => Size;
  sample: (
    argumentsFor: (output: string) => Promise<string[]>,
    output: string,
    target: Size,
    native: Size,
    signal: AbortSignal,
  ) => Promise<Buffer | undefined>;
};
