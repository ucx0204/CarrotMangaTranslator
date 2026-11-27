import { usesRegionInpainting } from "../../shared/inpaintingSettingsTypes";
import type { InpaintingEngine } from "./inpaintingEngine";
import { mergeRects, type PixelRect } from "./maskGeometry";

export function resolvePatternInpaintWindows(
  windows: PixelRect[],
  engine: InpaintingEngine,
  options: { preserveBlockOwnership?: boolean } = {},
): PixelRect[] {
  if (
    (engine.model === "codex" && options.preserveBlockOwnership) ||
    (usesRegionInpainting(engine.model) &&
      (engine.backend === "metal-native" || options.preserveBlockOwnership))
  ) {
    return windows.map((window) => ({ ...window }));
  }
  return mergeRects(windows);
}
