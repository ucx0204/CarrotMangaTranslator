const MAX_CANVAS_PIXELS = 4_000_000;
const MAX_PIXEL_RATIO = 2;

export type RetouchLivePoint = { x: number; y: number };

export type RetouchLiveGeometry = {
  displayHeight: number;
  displayWidth: number;
  imageHeight: number;
  imageWidth: number;
};

export type RetouchCanvasBackingSize = {
  height: number;
  pixelRatio: number;
  width: number;
};

function resolveRetouchCanvasPixelRatio(width: number, height: number): number {
  const nativeRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const area = Math.max(1, width * height);
  return Math.min(nativeRatio, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

export function resolveRetouchCanvasBackingSize(
  displayWidth: number,
  displayHeight: number,
): RetouchCanvasBackingSize {
  const pixelRatio = resolveRetouchCanvasPixelRatio(
    displayWidth,
    displayHeight,
  );
  return {
    height: Math.max(1, Math.round(displayHeight * pixelRatio)),
    pixelRatio,
    width: Math.max(1, Math.round(displayWidth * pixelRatio)),
  };
}
