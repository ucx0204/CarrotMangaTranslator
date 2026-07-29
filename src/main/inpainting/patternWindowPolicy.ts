import type { InpaintingEngine } from "./inpaintingEngine";
import { mergeRects, type PixelRect } from "./maskGeometry";

export function resolvePatternInpaintWindows(
  windows: PixelRect[],
  engine: InpaintingEngine,
  options: { preserveBlockOwnership?: boolean } = {},
): PixelRect[] {
  if (
    engine.model === "flux-klein" &&
    (engine.backend === "metal-native" || options.preserveBlockOwnership)
  ) {
    return windows.map((window) => ({ ...window }));
  }
  return mergeRects(windows);
}
