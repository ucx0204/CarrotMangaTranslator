import type { RetouchCanvasContext } from "./retouchCanvasContext";
import type {
  RetouchLiveGeometry,
  RetouchLivePoint,
} from "./retouchLiveGeometry";
import {
  clearPreviewCanvas,
  drawEraserSegment,
  findCanvas,
  getCanvasContext,
  prepareCanvas,
  renderShapePreview,
  type ShapePreviewFrame,
} from "./retouchLivePreviewDrawing";

export type RetouchLiveStyle = {
  color: string;
  mode: "brush" | "eraser" | "mask";
  radiusPx: number;
};

export type RetouchLiveShapeStyle = {
  color: string;
  kind: "rectangle" | "ellipse";
};

type CursorFrame = {
  geometry: RetouchLiveGeometry;
  point: RetouchLivePoint;
  radiusPx: number;
};

type StrokePreviewFrame = {
  kind: "stroke";
  geometry: RetouchLiveGeometry;
  lastDrawnPoint: RetouchLivePoint | null;
  pendingPoints: RetouchLivePoint[];
  style: RetouchLiveStyle;
};

type PreviewFrame = StrokePreviewFrame | ShapePreviewFrame;

type RetouchLiveState = {
  clearTimer: number | null;
  cursorFrame: CursorFrame | null;
  cursorHidden: boolean;
  frameId: number | null;
  previewFrame: PreviewFrame | null;
};

const liveStates = new WeakMap<HTMLElement, RetouchLiveState>();

export function queueRetouchCursor(
  stage: HTMLElement,
  point: RetouchLivePoint,
  geometry: RetouchLiveGeometry,
  radiusPx: number,
): void {
  const state = getLiveState(stage);
  state.cursorFrame = { geometry, point, radiusPx };
  state.cursorHidden = false;
  scheduleLiveFrame(stage, state);
}

export function hideRetouchCursor(stage: HTMLElement | null): void {
  if (!stage) return;
  const state = getLiveState(stage);
  state.cursorFrame = null;
  state.cursorHidden = true;
  const cursor = findCursor(stage);
  if (cursor) {
    cursor.style.opacity = "0";
    cursor.style.visibility = "hidden";
  }
}

export function beginRetouchStroke(
  stage: HTMLElement,
  point: RetouchLivePoint,
  geometry: RetouchLiveGeometry,
  style: RetouchLiveStyle,
): void {
  const state = getLiveState(stage);
  cancelPreviewClear(state);
  clearPreviewCanvas(stage);
  state.previewFrame = {
    kind: "stroke",
    geometry,
    lastDrawnPoint: null,
    pendingPoints: [point],
    style,
  };
  scheduleLiveFrame(stage, state);
}

export function appendRetouchStrokePoint(
  stage: HTMLElement,
  point: RetouchLivePoint,
  geometry: RetouchLiveGeometry,
): void {
  const state = getLiveState(stage);
  const preview = state.previewFrame;
  if (!preview || preview.kind !== "stroke") return;
  preview.geometry = geometry;
  preview.pendingPoints.push(point);
  scheduleLiveFrame(stage, state);
}

export function beginRetouchShape(
  stage: HTMLElement,
  start: RetouchLivePoint,
  geometry: RetouchLiveGeometry,
  style: RetouchLiveShapeStyle,
): void {
  const state = getLiveState(stage);
  cancelPreviewClear(state);
  clearPreviewCanvas(stage);
  state.previewFrame = {
    color: style.color,
    current: start,
    dirty: true,
    geometry,
    kind: style.kind,
    start,
  };
  scheduleLiveFrame(stage, state);
}

export function updateRetouchShape(
  stage: HTMLElement,
  current: RetouchLivePoint,
  geometry: RetouchLiveGeometry,
): void {
  const state = getLiveState(stage);
  const preview = state.previewFrame;
  if (!preview || preview.kind === "stroke") return;
  preview.current = current;
  preview.dirty = true;
  preview.geometry = geometry;
  scheduleLiveFrame(stage, state);
}

export function finishRetouchStroke(
  stage: HTMLElement | null,
  holdMilliseconds = 180,
): void {
  if (!stage) return;
  const state = getLiveState(stage);
  flushLiveFrame(stage, state);
  cancelPreviewClear(state);
  state.clearTimer = window.setTimeout(() => {
    clearRetouchPreview(stage, state);
  }, holdMilliseconds);
}

export function clearRetouchLiveOverlay(stage: HTMLElement | null): void {
  if (!stage) return;
  const state = liveStates.get(stage);
  if (state) {
    if (state.frameId !== null) {
      window.cancelAnimationFrame(state.frameId);
    }
    cancelPreviewClear(state);
  }
  hideRetouchCursorElement(stage);
  clearPreviewCanvas(stage);
  liveStates.delete(stage);
}

function getLiveState(stage: HTMLElement): RetouchLiveState {
  const current = liveStates.get(stage);
  if (current) return current;
  const next: RetouchLiveState = {
    clearTimer: null,
    cursorFrame: null,
    cursorHidden: true,
    frameId: null,
    previewFrame: null,
  };
  liveStates.set(stage, next);
  return next;
}

function scheduleLiveFrame(stage: HTMLElement, state: RetouchLiveState): void {
  if (state.frameId !== null) return;
  state.frameId = window.requestAnimationFrame(() => {
    state.frameId = null;
    flushLiveFrame(stage, state);
  });
}

function flushLiveFrame(stage: HTMLElement, state: RetouchLiveState): void {
  if (state.frameId !== null) {
    window.cancelAnimationFrame(state.frameId);
    state.frameId = null;
  }
  if (state.cursorHidden) {
    hideRetouchCursorElement(stage);
  } else if (state.cursorFrame) {
    renderCursor(stage, state.cursorFrame);
  }
  const preview = state.previewFrame;
  if (preview?.kind === "stroke" && preview.pendingPoints.length) {
    renderPendingPreview(stage, preview);
  } else if (preview?.kind !== "stroke" && preview?.dirty) {
    renderShapePreview(stage, preview);
  }
}

function renderCursor(stage: HTMLElement, frame: CursorFrame): void {
  const cursor = findCursor(stage);
  if (!cursor) return;
  const scaleX =
    frame.geometry.displayWidth / Math.max(1, frame.geometry.imageWidth);
  const scaleY =
    frame.geometry.displayHeight / Math.max(1, frame.geometry.imageHeight);
  const x = frame.point.x * scaleX;
  const y = frame.point.y * scaleY;
  const radius = Math.max(3, frame.radiusPx * Math.min(scaleX, scaleY));
  cursor.style.width = `${radius * 2}px`;
  cursor.style.height = `${radius * 2}px`;
  cursor.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  cursor.style.visibility = "visible";
  cursor.style.opacity = "1";
}

function renderPendingPreview(
  stage: HTMLElement,
  preview: StrokePreviewFrame,
): void {
  const canvas = findCanvas(stage);
  if (!canvas) {
    preview.pendingPoints.length = 0;
    return;
  }
  const context = getCanvasContext(canvas);
  if (!context) {
    preview.pendingPoints.length = 0;
    return;
  }
  const resized = prepareCanvas(canvas, context, preview.geometry);
  if (resized) {
    preview.lastDrawnPoint = null;
  }
  canvas.hidden = false;
  const points = preview.pendingPoints.splice(0);
  for (const point of points) {
    drawPreviewSegment(
      stage,
      context,
      preview.lastDrawnPoint,
      point,
      preview.geometry,
      preview.style,
    );
    preview.lastDrawnPoint = point;
  }
}

function drawPreviewSegment(
  stage: HTMLElement,
  context: RetouchCanvasContext,
  previous: RetouchLivePoint | null,
  current: RetouchLivePoint,
  geometry: RetouchLiveGeometry,
  style: RetouchLiveStyle,
): void {
  const scaleX = geometry.displayWidth / Math.max(1, geometry.imageWidth);
  const scaleY = geometry.displayHeight / Math.max(1, geometry.imageHeight);
  const from = previous
    ? { x: previous.x * scaleX, y: previous.y * scaleY }
    : { x: current.x * scaleX, y: current.y * scaleY };
  const to = { x: current.x * scaleX, y: current.y * scaleY };
  const radius = Math.max(0.5, style.radiusPx * Math.min(scaleX, scaleY));
  if (style.mode === "eraser") {
    drawEraserSegment(stage, context, from, to, radius, geometry);
    return;
  }
  context.save();
  context.globalAlpha = style.mode === "mask" ? 0.5 : 0.92;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = radius * 2;
  context.strokeStyle = style.mode === "mask" ? "#ff9f1c" : style.color;
  context.fillStyle = context.strokeStyle;
  if (pointsMatch(from, to)) {
    context.beginPath();
    context.arc(to.x, to.y, radius, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }
  context.restore();
}

function pointsMatch(
  first: RetouchLivePoint,
  second: RetouchLivePoint,
): boolean {
  return first.x === second.x && first.y === second.y;
}

function clearRetouchPreview(
  stage: HTMLElement,
  state: RetouchLiveState,
): void {
  state.clearTimer = null;
  state.previewFrame = null;
  clearPreviewCanvas(stage);
}

function cancelPreviewClear(state: RetouchLiveState): void {
  if (state.clearTimer === null) return;
  window.clearTimeout(state.clearTimer);
  state.clearTimer = null;
}

function findCursor(stage: HTMLElement): HTMLElement | null {
  return stage.querySelector<HTMLElement>("[data-retouch-live-cursor]");
}

function hideRetouchCursorElement(stage: HTMLElement): void {
  const cursor = findCursor(stage);
  if (!cursor) return;
  cursor.style.opacity = "0";
  cursor.style.visibility = "hidden";
}
