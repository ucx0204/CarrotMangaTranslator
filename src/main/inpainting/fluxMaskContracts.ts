import type { InpaintingWindowMask } from "./inpaintingEngine";
import type { IllustratedTitleHint } from "./fluxWorkerTypes";

type FluxMaskOptions = {
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  compositeFeatherPx?: number[];
  compositeMasks?: InpaintingWindowMask[];
  windowMasks?: InpaintingWindowMask[];
  speechBubbleWindows?: boolean[];
  illustratedTitleWindows?: IllustratedTitleHint[];
  windowProcessingOrder?: readonly number[];
};

function assertWindowProcessingOrder(
  order: readonly number[] | undefined,
  windowCount: number,
) {
  if (
    order &&
    (order.length !== windowCount ||
      new Set(order).size !== windowCount ||
      order.some((i) => !Number.isInteger(i) || i < 0 || i >= windowCount))
  ) {
    throw new Error("Window processing order must include each window once.");
  }
}

export function assertFluxMaskContracts(options: {
  isolateWindowMasks: boolean;
  runOptions: FluxMaskOptions;
  windowCount: number;
}): void {
  const { isolateWindowMasks, runOptions, windowCount } = options;
  assertWindowProcessingOrder(runOptions.windowProcessingOrder, windowCount);
  const alignedMetadata = [
    [
      isolateWindowMasks ? runOptions.windowMasks : undefined,
      "Block-owned mask",
    ],
    [runOptions.compositeMasks, "Composite mask"],
    [runOptions.speechBubbleWindows, "Speech bubble hint"],
    [runOptions.illustratedTitleWindows, "Illustrated title hint"],
  ] as const;
  for (const [values, label] of alignedMetadata) {
    if (values && values.length !== windowCount) {
      throw new Error(`${label} count does not match Flux window count.`);
    }
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
