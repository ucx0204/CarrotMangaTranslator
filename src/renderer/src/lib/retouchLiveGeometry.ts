const MAX_CANVAS_PIXELS = 4_000_000;
const MAX_PIXEL_RATIO = 2;

export function resolveRetouchCanvasPixelRatio(
  width: number,
  height: number,
): number {
  const nativeRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const area = Math.max(1, width * height);
  return Math.min(nativeRatio, Math.sqrt(MAX_CANVAS_PIXELS / area));
}
