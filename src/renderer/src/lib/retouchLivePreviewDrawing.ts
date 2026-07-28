import type { RetouchCanvasContext } from "./retouchCanvasContext";
import {
  resolveRetouchCanvasBackingSize,
  type RetouchLiveGeometry,
  type RetouchLivePoint,
} from "./retouchLiveGeometry";

export type ShapePreviewFrame = {
  color: string;
  current: RetouchLivePoint;
  dirty: boolean;
  geometry: RetouchLiveGeometry;
  kind: "rectangle" | "ellipse";
  start: RetouchLivePoint;
};

export function renderShapePreview(
  stage: HTMLElement,
  preview: ShapePreviewFrame,
): void {
  const canvas = findCanvas(stage);
  if (!canvas) {
    preview.dirty = false;
    return;
  }
  const context = getCanvasContext(canvas);
  if (!context) {
    preview.dirty = false;
    return;
  }
  prepareCanvas(canvas, context, preview.geometry);
  context.clearRect(
    0,
    0,
    preview.geometry.displayWidth,
    preview.geometry.displayHeight,
  );
  canvas.hidden = false;
  const scaleX =
    preview.geometry.displayWidth / Math.max(1, preview.geometry.imageWidth);
  const scaleY =
    preview.geometry.displayHeight / Math.max(1, preview.geometry.imageHeight);
  const startX = preview.start.x * scaleX;
  const startY = preview.start.y * scaleY;
  const currentX = preview.current.x * scaleX;
  const currentY = preview.current.y * scaleY;
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  const width = Math.max(1, Math.abs(currentX - startX));
  const height = Math.max(1, Math.abs(currentY - startY));
  context.save();
  context.globalAlpha = 0.92;
  context.fillStyle = preview.color;
  if (preview.kind === "rectangle") {
    context.fillRect(left, top, width, height);
  } else {
    context.beginPath();
    context.ellipse(
      left + width / 2,
      top + height / 2,
      width / 2,
      height / 2,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.restore();
  preview.dirty = false;
}

export function drawEraserSegment(
  stage: HTMLElement,
  context: RetouchCanvasContext,
  from: RetouchLivePoint,
  to: RetouchLivePoint,
  radius: number,
  geometry: RetouchLiveGeometry,
): void {
  const source = findOriginalSource(stage);
  context.save();
  traceCapsule(context, from, to, radius);
  context.clip();
  if (source?.complete && source.naturalWidth > 0 && source.naturalHeight > 0) {
    const bounds = resolveSegmentBounds(from, to, radius, geometry);
    const sourceX = (bounds.x / geometry.displayWidth) * source.naturalWidth;
    const sourceY = (bounds.y / geometry.displayHeight) * source.naturalHeight;
    const sourceWidth =
      (bounds.width / geometry.displayWidth) * source.naturalWidth;
    const sourceHeight =
      (bounds.height / geometry.displayHeight) * source.naturalHeight;
    context.drawImage(
      source,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    );
  } else {
    context.fillStyle = "rgba(112, 183, 255, 0.24)";
    context.fillRect(0, 0, geometry.displayWidth, geometry.displayHeight);
  }
  context.restore();
  context.save();
  context.globalAlpha = 0.78;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = radius * 2;
  context.strokeStyle = "rgba(112, 183, 255, 0.9)";
  context.setLineDash([8, 5]);
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.restore();
}

export function prepareCanvas(
  canvas: HTMLCanvasElement,
  context: RetouchCanvasContext,
  geometry: RetouchLiveGeometry,
): boolean {
  const backingSize = resolveRetouchCanvasBackingSize(
    geometry.displayWidth,
    geometry.displayHeight,
  );
  const resized =
    canvas.width !== backingSize.width || canvas.height !== backingSize.height;
  if (resized) {
    canvas.width = backingSize.width;
    canvas.height = backingSize.height;
  }
  const ratio = backingSize.pixelRatio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return resized;
}

export function clearPreviewCanvas(stage: HTMLElement): void {
  const canvas = findCanvas(stage);
  if (!canvas) return;
  const context = getCanvasContext(canvas);
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.hidden = true;
}

export function getCanvasContext(
  canvas: HTMLCanvasElement,
): RetouchCanvasContext | null {
  try {
    return canvas.getContext("2d");
  } catch (error) {
    // Canvas is optional in non-visual test environments.
    void error;
    return null;
  }
}

export function findCanvas(stage: HTMLElement): HTMLCanvasElement | null {
  return stage.querySelector<HTMLCanvasElement>("[data-retouch-live-canvas]");
}

function traceCapsule(
  context: RetouchCanvasContext,
  from: RetouchLivePoint,
  to: RetouchLivePoint,
  radius: number,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
    context.beginPath();
    context.arc(to.x, to.y, radius, 0, Math.PI * 2);
    context.closePath();
    return;
  }
  const angle = Math.atan2(dy, dx);
  const normalX = -Math.sin(angle) * radius;
  const normalY = Math.cos(angle) * radius;
  context.beginPath();
  context.moveTo(from.x + normalX, from.y + normalY);
  context.lineTo(to.x + normalX, to.y + normalY);
  context.arc(to.x, to.y, radius, angle + Math.PI / 2, angle - Math.PI / 2);
  context.lineTo(from.x - normalX, from.y - normalY);
  context.arc(from.x, from.y, radius, angle - Math.PI / 2, angle + Math.PI / 2);
  context.closePath();
}

function resolveSegmentBounds(
  from: RetouchLivePoint,
  to: RetouchLivePoint,
  radius: number,
  geometry: RetouchLiveGeometry,
): { height: number; width: number; x: number; y: number } {
  const x = Math.max(0, Math.min(from.x, to.x) - radius - 1);
  const y = Math.max(0, Math.min(from.y, to.y) - radius - 1);
  const right = Math.min(
    geometry.displayWidth,
    Math.max(from.x, to.x) + radius + 1,
  );
  const bottom = Math.min(
    geometry.displayHeight,
    Math.max(from.y, to.y) + radius + 1,
  );
  return {
    height: Math.max(1, bottom - y),
    width: Math.max(1, right - x),
    x,
    y,
  };
}

function findOriginalSource(stage: HTMLElement): HTMLImageElement | null {
  return stage.querySelector<HTMLImageElement>(
    "[data-retouch-original-source]",
  );
}
