import {
  createPerspectivePreset,
  MAX_BLOCK_LOCAL_COORDINATE,
  MIN_BLOCK_LOCAL_COORDINATE,
  MIN_PERSPECTIVE_AREA,
  MIN_PERSPECTIVE_EDGE_LENGTH,
  PERSPECTIVE_PRESETS,
} from "./blockTransformPresets";
import type { PerspectiveTransform, Point } from "./textTypes";

const EPSILON = 1e-9;
const PRECISION = 1_000_000;

type PerspectiveValidationReason =
  | "wrong-corner-count"
  | "non-finite"
  | "out-of-range"
  | "edge-too-short"
  | "self-intersection"
  | "area-too-small"
  | "concave"
  | "flipped";

type PerspectiveValidationResult = {
  valid: boolean;
  reason?: PerspectiveValidationReason;
  area: number;
  minEdgeLength: number;
};

export type CssMatrix3d = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export function validatePerspectiveCorners(
  corners: readonly Point[],
): PerspectiveValidationResult {
  if (corners.length !== 4) return invalid("wrong-corner-count");
  if (!corners.every(isFinitePoint)) return invalid("non-finite");
  if (!corners.every(isPointWithinBounds)) return invalid("out-of-range");

  const area = Math.abs(signedArea(corners));
  const minEdgeLength = Math.min(
    ...corners.map((value, index) =>
      distance(value, corners[(index + 1) % corners.length]),
    ),
  );
  const result = (reason?: PerspectiveValidationReason) => ({
    valid: reason === undefined,
    ...(reason ? { reason } : {}),
    area,
    minEdgeLength,
  });
  return result(resolveShapeError(corners, area, minEdgeLength));
}

function resolveShapeError(
  corners: readonly Point[],
  area: number,
  minEdgeLength: number,
): PerspectiveValidationReason | undefined {
  if (minEdgeLength < MIN_PERSPECTIVE_EDGE_LENGTH) return "edge-too-short";
  const crosses =
    segmentsIntersect(corners[0], corners[1], corners[2], corners[3]) ||
    segmentsIntersect(corners[1], corners[2], corners[3], corners[0]);
  if (crosses) return "self-intersection";
  if (area < MIN_PERSPECTIVE_AREA) return "area-too-small";
  const turns = corners.map((value, index) =>
    cross(
      value,
      corners[(index + 1) % corners.length],
      corners[(index + 2) % corners.length],
    ),
  );
  if (turns.some((value) => Math.abs(value) <= EPSILON)) return "concave";
  const allPositive = turns.every((value) => value > 0);
  const allNegative = turns.every((value) => value < 0);
  if (!allPositive && !allNegative) return "concave";
  if (signedArea(corners) < 0 || allNegative) return "flipped";
  return undefined;
}

export function isValidPerspectiveTransform(
  transform: PerspectiveTransform | null | undefined,
): transform is PerspectiveTransform {
  return Boolean(
    transform?.version === 1 &&
    Array.isArray(transform.corners) &&
    validatePerspectiveCorners(transform.corners).valid,
  );
}

/** Normalize precision and bounds, falling back to identity if unsafe. */
export function normalizePerspectiveTransform(
  transform: PerspectiveTransform | null | undefined,
): PerspectiveTransform {
  if (
    !transform ||
    transform.version !== 1 ||
    !Array.isArray(transform.corners) ||
    transform.corners.length !== 4
  ) {
    return createPerspectivePreset("identity");
  }
  const fallback = PERSPECTIVE_PRESETS.identity.corners;
  const corners = transform.corners.map((value, index) =>
    normalizePoint(value, fallback[index]),
  ) as [Point, Point, Point, Point];
  const normalized = { version: 1 as const, corners };
  return isValidPerspectiveTransform(normalized)
    ? normalized
    : createPerspectivePreset("identity");
}

/** Map a point in the unit source rectangle into a perspective quad. */
export function mapPointToQuad(
  point: Point,
  corners: PerspectiveTransform["corners"],
): Point {
  return mapPointWithHomography(point, unitSquareToQuadHomography(corners));
}

/** Map (0,0)-(width,height) onto normalized corners scaled by that size. */
export function rectToQuadMatrix3d(
  width: number,
  height: number,
  corners: PerspectiveTransform["corners"],
): CssMatrix3d {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError(
      "Perspective source rectangle must have a positive size.",
    );
  }
  const value = unitSquareToQuadHomography(corners);
  return [
    value.a,
    (height / width) * value.d,
    0,
    value.g / width,
    (width / height) * value.b,
    value.e,
    0,
    value.h / height,
    0,
    0,
    1,
    0,
    width * value.c,
    height * value.f,
    0,
    1,
  ];
}

export function mapPointWithMatrix3d(point: Point, matrix: CssMatrix3d): Point {
  const denominator = matrix[3] * point.x + matrix[7] * point.y + matrix[15];
  if (Math.abs(denominator) <= EPSILON) {
    throw new RangeError("Perspective point maps to infinity.");
  }
  return {
    x: (matrix[0] * point.x + matrix[4] * point.y + matrix[12]) / denominator,
    y: (matrix[1] * point.x + matrix[5] * point.y + matrix[13]) / denominator,
  };
}

export function matrix3dToCss(matrix: CssMatrix3d): string {
  return `matrix3d(${matrix.map(formatNumber).join(", ")})`;
}

type Homography = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
};

function unitSquareToQuadHomography(
  corners: PerspectiveTransform["corners"],
): Homography {
  const validation = validatePerspectiveCorners(corners);
  if (!validation.valid) {
    throw new RangeError(
      `Cannot create a perspective matrix from an unsafe quad (${validation.reason ?? "invalid"}).`,
    );
  }
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > EPSILON || Math.abs(dy3) > EPSILON) {
    const denominator = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(denominator) <= EPSILON) {
      throw new RangeError("Perspective quad has no stable homography.");
    }
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
  }
  return {
    a: topRight.x - topLeft.x + g * topRight.x,
    b: bottomLeft.x - topLeft.x + h * bottomLeft.x,
    c: topLeft.x,
    d: topRight.y - topLeft.y + g * topRight.y,
    e: bottomLeft.y - topLeft.y + h * bottomLeft.y,
    f: topLeft.y,
    g,
    h,
  };
}

function mapPointWithHomography(point: Point, value: Homography): Point {
  const denominator = value.g * point.x + value.h * point.y + 1;
  if (Math.abs(denominator) <= EPSILON) {
    throw new RangeError("Perspective point maps to infinity.");
  }
  return {
    x: (value.a * point.x + value.b * point.y + value.c) / denominator,
    y: (value.d * point.x + value.e * point.y + value.f) / denominator,
  };
}

function normalizePoint(value: Point | undefined, fallback: Point): Point {
  return {
    x: normalizeCoordinate(value?.x, fallback.x),
    y: normalizeCoordinate(value?.y, fallback.y),
  };
}

function normalizeCoordinate(
  value: number | undefined,
  fallback: number,
): number {
  const finite = Number.isFinite(value) ? (value as number) : fallback;
  const clamped = Math.min(
    MAX_BLOCK_LOCAL_COORDINATE,
    Math.max(MIN_BLOCK_LOCAL_COORDINATE, finite),
  );
  const rounded =
    Math.round((clamped + Number.EPSILON) * PRECISION) / PRECISION;
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

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function signedArea(points: readonly Point[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const value = points[index];
    const next = points[(index + 1) % points.length];
    sum += value.x * next.y - next.x * value.y;
  }
  return sum / 2;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const values = [
    cross(a, b, c),
    cross(a, b, d),
    cross(c, d, a),
    cross(c, d, b),
  ];
  const proper = values[0] * values[1] < 0 && values[2] * values[3] < 0;
  if (proper) return true;
  return (
    (Math.abs(values[0]) <= EPSILON && onSegment(c, a, b)) ||
    (Math.abs(values[1]) <= EPSILON && onSegment(d, a, b)) ||
    (Math.abs(values[2]) <= EPSILON && onSegment(a, c, d)) ||
    (Math.abs(values[3]) <= EPSILON && onSegment(b, c, d))
  );
}

function onSegment(value: Point, start: Point, end: Point): boolean {
  return (
    value.x >= Math.min(start.x, end.x) - EPSILON &&
    value.x <= Math.max(start.x, end.x) + EPSILON &&
    value.y >= Math.min(start.y, end.y) - EPSILON &&
    value.y <= Math.max(start.y, end.y) + EPSILON
  );
}

function invalid(
  reason: PerspectiveValidationReason,
): PerspectiveValidationResult {
  return { valid: false, reason, area: 0, minEdgeLength: 0 };
}

function formatNumber(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * PRECISION) / PRECISION;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
