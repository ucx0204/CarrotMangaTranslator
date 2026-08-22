import type { InpaintingWindowMask } from "./inpaintingEngine";

type FluxMaskOptions = {
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  compositeFeatherPx?: number[];
  compositeMasks?: InpaintingWindowMask[];
  windowMasks?: InpaintingWindowMask[];
};

export function assertFluxMaskContracts(options: {
  isolateWindowMasks: boolean;
  runOptions: FluxMaskOptions;
  windowCount: number;
}): void {
  const { isolateWindowMasks, runOptions, windowCount } = options;
  if (
    isolateWindowMasks &&
    runOptions.windowMasks &&
    runOptions.windowMasks.length !== windowCount
  ) {
    throw new Error("Block-owned mask count does not match Flux window count.");
  }
  if (
    runOptions.compositeMasks &&
    runOptions.compositeMasks.length !== windowCount
  ) {
    throw new Error("Composite mask count does not match Flux window count.");
  }
  if (!runOptions.compositeConstraints) return;
  if (
    runOptions.compositeConstraints.length !== windowCount ||
    runOptions.windowMasks?.length !== windowCount ||
    (runOptions.compositeFeatherPx !== undefined &&
      runOptions.compositeFeatherPx.length !== windowCount)
  ) {
    throw new Error(
      "Composite constraint count does not match Flux window count.",
    );
  }
}
