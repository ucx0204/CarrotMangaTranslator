import type { InpaintingEngine } from "./inpaintingEngine";
import { mergeRects, type PixelRect } from "./maskGeometry";

export function resolvePatternInpaintWindows(
  windows: PixelRect[],
  engine: InpaintingEngine,
): PixelRect[] {
  if (engine.model === "flux-klein" && engine.backend === "metal-native") {
    return windows.map((window) => ({ ...window }));
  }
  return mergeRects(windows);
}
