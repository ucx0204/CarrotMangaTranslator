import type { PixelRect } from "./maskGeometry";

export function resolvePatternInpaintWindows(
  windows: PixelRect[],
): PixelRect[] {
  return windows.map((window) => ({ ...window }));
}
