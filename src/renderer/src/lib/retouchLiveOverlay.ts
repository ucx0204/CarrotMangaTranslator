export type RetouchLivePoint = { x: number; y: number };

export type RetouchLiveGeometry = {
  displayHeight: number;
  displayWidth: number;
  imageHeight: number;
  imageWidth: number;
};

export type RetouchLiveStyle = {
  color: string;
  mode: "brush" | "eraser" | "mask";
  radiusPx: number;
};

type CursorFrame = {
  geometry: RetouchLiveGeometry;
  point: RetouchLivePoint;
  radiusPx: number;
};

type PreviewFrame = {
  geometry: RetouchLiveGeometry;
  lastDrawnPoint: RetouchLivePoint | null;
  pendingPoints: RetouchLivePoint[];
  style: RetouchLiveStyle;
};

type RetouchLiveState = {
  clearTimer: number | null;
  cursorFrame: CursorFrame | null;
  cursorHidden: boolean;
  frameId: number | null;
  previewFrame: PreviewFrame | null;
};

const liveStates = new WeakMap<HTMLElement, RetouchLiveState>();
const MAX_CANVAS_PIXELS = 4_000_000;
const MAX_PIXEL_RATIO = 2;

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
  if (!preview) return;
  preview.geometry = geometry;
  preview.pendingPoints.push(point);
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
  if (state.previewFrame?.pendingPoints.length) {
    renderPendingPreview(stage, state.previewFrame);
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

function renderPendingPreview(stage: HTMLElement, preview: PreviewFrame): void {
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

function prepareCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  geometry: RetouchLiveGeometry,
): boolean {
  const ratio = resolveCanvasPixelRatio(
    geometry.displayWidth,
    geometry.displayHeight,
  );
  const width = Math.max(1, Math.round(geometry.displayWidth * ratio));
  const height = Math.max(1, Math.round(geometry.displayHeight * ratio));
  const resized = canvas.width !== width || canvas.height !== height;
  if (resized) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return resized;
}

function resolveCanvasPixelRatio(width: number, height: number): number {
  const nativeRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const area = Math.max(1, width * height);
  return Math.min(nativeRatio, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

function drawPreviewSegment(
  stage: HTMLElement,
  context: CanvasRenderingContext2D,
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

function drawEraserSegment(
  stage: HTMLElement,
  context: CanvasRenderingContext2D,
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

function traceCapsule(
  context: CanvasRenderingContext2D,
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

function clearPreviewCanvas(stage: HTMLElement): void {
  const canvas = findCanvas(stage);
  if (!canvas) return;
  const context = getCanvasContext(canvas);
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.hidden = true;
}

function getCanvasContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch (error) {
    // Canvas is optional in non-visual test environments.
    void error;
    return null;
  }
}

function findCanvas(stage: HTMLElement): HTMLCanvasElement | null {
  return stage.querySelector<HTMLCanvasElement>("[data-retouch-live-canvas]");
}

function findCursor(stage: HTMLElement): HTMLElement | null {
  return stage.querySelector<HTMLElement>("[data-retouch-live-cursor]");
}

function findOriginalSource(stage: HTMLElement): HTMLImageElement | null {
  return stage.querySelector<HTMLImageElement>(
    "[data-retouch-original-source]",
  );
}

function hideRetouchCursorElement(stage: HTMLElement): void {
  const cursor = findCursor(stage);
  if (!cursor) return;
  cursor.style.opacity = "0";
  cursor.style.visibility = "hidden";
}
