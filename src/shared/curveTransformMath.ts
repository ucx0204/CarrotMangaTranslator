import {
  createCurvePreset,
  CURVE_PRESETS,
  MAX_BLOCK_LOCAL_COORDINATE,
  MAX_CURVE_OFFSET_EM,
  MIN_BLOCK_LOCAL_COORDINATE,
  MIN_CURVE_CHORD_LENGTH,
  MIN_CURVE_OFFSET_EM,
  MIN_CURVE_PATH_LENGTH,
} from "./blockTransformPresets";
import type { CurveLayout, Point, QuadraticCurvePath } from "./textTypes";

const EPSILON = 1e-9;
const COORDINATE_PRECISION = 1_000_000;
const VALUE_PRECISION = 10_000;

type QuadraticPathValidationReason =
  | "non-finite"
  | "out-of-range"
  | "chord-too-short"
  | "path-too-short";

type QuadraticPathValidationResult = {
  valid: boolean;
  reason?: QuadraticPathValidationReason;
  chordLength: number;
  pathLength: number;
};

export function validateQuadraticPath(
  path: QuadraticCurvePath,
): QuadraticPathValidationResult {
  const points = [path.start, path.control, path.end];
  if (!points.every(isFinitePoint)) return invalid("non-finite");
  if (!points.every(isPointWithinBounds)) return invalid("out-of-range");

  const chordLength = distance(path.start, path.end);
  const pathLength = quadraticLength(path);
  const result = (reason?: QuadraticPathValidationReason) => ({
    valid: reason === undefined,
    ...(reason ? { reason } : {}),
    chordLength,
    pathLength,
  });
  if (chordLength < MIN_CURVE_CHORD_LENGTH) {
    return result("chord-too-short");
  }
  if (pathLength < MIN_CURVE_PATH_LENGTH) return result("path-too-short");
  return result();
}

/** Normalize a saved/editor layout, falling back to straight if unsafe. */
export function normalizeCurveLayout(
  layout: CurveLayout | null | undefined,
): CurveLayout {
  if (!layout || layout.version !== 1 || layout.path.type !== "quadratic") {
    return createCurvePreset("straight");
  }
  const fallback = CURVE_PRESETS.straight.path;
  const path: QuadraticCurvePath = {
    type: "quadratic",
    start: normalizePoint(layout.path.start, fallback.start),
    control: normalizePoint(layout.path.control, fallback.control),
    end: normalizePoint(layout.path.end, fallback.end),
  };
  if (!validateQuadraticPath(path).valid) return createCurvePreset("straight");
  return {
    version: 1,
    path,
    alignment: isAlignment(layout.alignment) ? layout.alignment : "center",
    offsetEm: normalizeNumber(
      layout.offsetEm,
      0,
      MIN_CURVE_OFFSET_EM,
      MAX_CURVE_OFFSET_EM,
      VALUE_PRECISION,
    ),
    orientation: isOrientation(layout.orientation)
      ? layout.orientation
      : "tangent",
    ...(layout.reversed === true ? { reversed: true } : {}),
    ...(layout.fitSpacing === true ? { fitSpacing: true } : {}),
  };
}

export function quadraticPointAt(path: QuadraticCurvePath, t: number): Point {
  const safeT = clampUnit(t);
  const inverse = 1 - safeT;
  return {
    x:
      inverse * inverse * path.start.x +
      2 * inverse * safeT * path.control.x +
      safeT * safeT * path.end.x,
    y:
      inverse * inverse * path.start.y +
      2 * inverse * safeT * path.control.y +
      safeT * safeT * path.end.y,
  };
}

/** Unit tangent, suitable for atan2(tangent.y, tangent.x). */
export function quadraticTangentAt(path: QuadraticCurvePath, t: number): Point {
  const safeT = clampUnit(t);
  let dx =
    2 *
    ((1 - safeT) * (path.control.x - path.start.x) +
      safeT * (path.end.x - path.control.x));
  let dy =
    2 *
    ((1 - safeT) * (path.control.y - path.start.y) +
      safeT * (path.end.y - path.control.y));
  let magnitude = Math.hypot(dx, dy);
  if (magnitude <= EPSILON) {
    dx = path.end.x - path.start.x;
    dy = path.end.y - path.start.y;
    magnitude = Math.hypot(dx, dy);
  }
  return magnitude <= EPSILON
    ? { x: 1, y: 0 }
    : { x: dx / magnitude, y: dy / magnitude };
}

export function quadraticLength(path: QuadraticCurvePath): number {
  const speed = (t: number): number => {
    const dx =
      2 *
      ((1 - t) * (path.control.x - path.start.x) +
        t * (path.end.x - path.control.x));
    const dy =
      2 *
      ((1 - t) * (path.control.y - path.start.y) +
        t * (path.end.y - path.control.y));
    return Math.hypot(dx, dy);
  };
  const whole = simpson(speed, 0, 1);
  return adaptiveSimpson(speed, 0, 1, 1e-7, whole, 12);
}

export function quadraticPathToSvg(path: QuadraticCurvePath): string {
  return `M ${formatNumber(path.start.x)} ${formatNumber(path.start.y)} Q ${formatNumber(path.control.x)} ${formatNumber(path.control.y)} ${formatNumber(path.end.x)} ${formatNumber(path.end.y)}`;
}

function normalizePoint(value: Point | undefined, fallback: Point): Point {
  return {
    x: normalizeNumber(
      value?.x,
      fallback.x,
      MIN_BLOCK_LOCAL_COORDINATE,
      MAX_BLOCK_LOCAL_COORDINATE,
      COORDINATE_PRECISION,
    ),
    y: normalizeNumber(
      value?.y,
      fallback.y,
      MIN_BLOCK_LOCAL_COORDINATE,
      MAX_BLOCK_LOCAL_COORDINATE,
      COORDINATE_PRECISION,
    ),
  };
}

function normalizeNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  precision: number,
): number {
  const finite = Number.isFinite(value) ? (value as number) : fallback;
  const clamped = Math.min(max, Math.max(min, finite));
  const rounded =
    Math.round((clamped + Number.EPSILON) * precision) / precision;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isFinitePoint(value: Point | null | undefined): value is Point {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y));
}

function isPointWithinBounds(value: Point): boolean {
  return (
    value.x >= MIN_BLOCK_LOCAL_COORDINATE &&
    value.x <= MAX_BLOCK_LOCAL_COORDINATE &&
    value.y >= MIN_BLOCK_LOCAL_COORDINATE &&
    value.y <= MAX_BLOCK_LOCAL_COORDINATE
  );
}

function isAlignment(value: unknown): value is CurveLayout["alignment"] {
  return value === "start" || value === "center" || value === "end";
}

function isOrientation(value: unknown): value is CurveLayout["orientation"] {
  return value === "tangent" || value === "upright";
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function invalid(
  reason: QuadraticPathValidationReason,
): QuadraticPathValidationResult {
  return { valid: false, reason, chordLength: 0, pathLength: 0 };
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function simpson(
  fn: (value: number) => number,
  start: number,
  end: number,
): number {
  const midpoint = (start + end) / 2;
  return ((end - start) / 6) * (fn(start) + 4 * fn(midpoint) + fn(end));
}

function adaptiveSimpson(
  fn: (value: number) => number,
  start: number,
  end: number,
  epsilon: number,
  whole: number,
  depth: number,
): number {
  const midpoint = (start + end) / 2;
  const left = simpson(fn, start, midpoint);
  const right = simpson(fn, midpoint, end);
  const delta = left + right - whole;
  if (depth <= 0 || Math.abs(delta) <= 15 * epsilon) {
    return left + right + delta / 15;
  }
  return (
    adaptiveSimpson(fn, start, midpoint, epsilon / 2, left, depth - 1) +
    adaptiveSimpson(fn, midpoint, end, epsilon / 2, right, depth - 1)
  );
}

function formatNumber(value: number): string {
  const rounded =
    Math.round((value + Number.EPSILON) * COORDINATE_PRECISION) /
    COORDINATE_PRECISION;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
