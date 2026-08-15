import {
  MAX_BLOCK_LOCAL_COORDINATE,
  MIN_BLOCK_LOCAL_COORDINATE,
} from "./blockTransformPresets";
import type { Point, WarpGridSize, WarpTransform } from "./textTypes";
import {
  createPointWarpEvaluator,
  type PointWarpEvaluator,
} from "./thinPlateSpline";

const PRECISION = 1_000_000;
const MIN_JACOBIAN = 0.015;
const MIN_AXIS_SCALE = 0.025;
const VALIDATION_SAMPLES_PER_CELL = 4;

export const WARP_PRESET_NAMES = [
  "archUp",
  "archDown",
  "bulge",
  "squeeze",
  "flag",
  "wave",
] as const;

export type WarpPresetName = (typeof WARP_PRESET_NAMES)[number];

type WarpValidationReason =
  | "wrong-version"
  | "wrong-grid-size"
  | "wrong-point-count"
  | "non-finite"
  | "out-of-range"
  | "singular"
  | "folded"
  | "compressed";

type WarpValidationResult = {
  valid: boolean;
  reason?: WarpValidationReason;
  minimumJacobian: number;
  minimumAxisScale: number;
};

export function warpPointCount(gridSize: WarpGridSize): number {
  return (gridSize + 1) ** 2;
}

export function createIdentityWarpTransform(
  gridSize: WarpGridSize = 3,
): WarpTransform {
  return {
    version: 1,
    gridSize,
    points: createIdentityWarpPoints(gridSize),
  };
}

export function createIdentityWarpPoints(gridSize: WarpGridSize): Point[] {
  const side = gridSize + 1;
  return Array.from({ length: side * side }, (_, index) => ({
    x: (index % side) / gridSize,
    y: Math.floor(index / side) / gridSize,
  }));
}

export function createWarpPreset(
  name: WarpPresetName,
  gridSize: WarpGridSize = 3,
): WarpTransform {
  const points = createIdentityWarpPoints(gridSize).map((point) =>
    normalizePoint(applyPreset(name, point)),
  );
  const transform = { version: 1 as const, gridSize, points };
  if (!isValidWarpTransform(transform)) {
    throw new RangeError(`Warp preset is unsafe: ${name}`);
  }
  return transform;
}

export function isIdentityWarpTransform(
  transform: WarpTransform | null | undefined,
  tolerance = 1e-7,
): boolean {
  if (!transform || !isWarpGridSize(transform.gridSize)) return false;
  const identity = createIdentityWarpPoints(transform.gridSize);
  return (
    transform.points.length === identity.length &&
    transform.points.every(
      (point, index) =>
        Math.abs(point.x - identity[index].x) <= tolerance &&
        Math.abs(point.y - identity[index].y) <= tolerance,
    )
  );
}

export function validateWarpTransform(
  transform: WarpTransform | null | undefined,
): WarpValidationResult {
  if (!transform || transform.version !== 1) {
    return invalid("wrong-version");
  }
  if (!isWarpGridSize(transform.gridSize)) {
    return invalid("wrong-grid-size");
  }
  if (transform.points.length !== warpPointCount(transform.gridSize)) {
    return invalid("wrong-point-count");
  }
  const pointError = resolveWarpPointError(transform.points);
  if (pointError) return invalid(pointError);

  let evaluator: PointWarpEvaluator;
  try {
    evaluator = createWarpEvaluator(transform);
  } catch (_error) {
    return invalid("singular");
  }

  let minimumJacobian = Number.POSITIVE_INFINITY;
  let minimumAxisScale = Number.POSITIVE_INFINITY;
  const sampleCount = transform.gridSize * VALIDATION_SAMPLES_PER_CELL;
  for (let row = 0; row <= sampleCount; row += 1) {
    for (let column = 0; column <= sampleCount; column += 1) {
      const derivative = evaluator.jacobian({
        x: column / sampleCount,
        y: row / sampleCount,
      });
      const determinant =
        derivative.xx * derivative.yy - derivative.xy * derivative.yx;
      const xScale = Math.hypot(derivative.xx, derivative.yx);
      const yScale = Math.hypot(derivative.xy, derivative.yy);
      minimumJacobian = Math.min(minimumJacobian, determinant);
      minimumAxisScale = Math.min(minimumAxisScale, xScale, yScale);
      if (!Number.isFinite(determinant) || determinant <= MIN_JACOBIAN) {
        return {
          valid: false,
          reason: "folded",
          minimumJacobian,
          minimumAxisScale,
        };
      }
      if (minimumAxisScale < MIN_AXIS_SCALE) {
        return {
          valid: false,
          reason: "compressed",
          minimumJacobian,
          minimumAxisScale,
        };
      }
    }
  }
  return { valid: true, minimumJacobian, minimumAxisScale };
}

export function isValidWarpTransform(
  transform: WarpTransform | null | undefined,
): transform is WarpTransform {
  return validateWarpTransform(transform).valid;
}

export function createWarpEvaluator(
  transform: WarpTransform,
): PointWarpEvaluator {
  if (!isWarpGridSize(transform.gridSize)) {
    throw new RangeError("Warp grid size must be 3 or 5.");
  }
  const source = createIdentityWarpPoints(transform.gridSize);
  if (transform.points.length !== source.length) {
    throw new RangeError("Warp point count does not match its grid size.");
  }
  return createPointWarpEvaluator(source, transform.points);
}

export function createInverseWarpEvaluator(
  transform: WarpTransform,
): PointWarpEvaluator {
  const source = createIdentityWarpPoints(transform.gridSize);
  if (transform.points.length !== source.length) {
    throw new RangeError("Warp point count does not match its grid size.");
  }
  return createPointWarpEvaluator(transform.points, source);
}

export function resampleWarpTransform(
  transform: WarpTransform,
  gridSize: WarpGridSize,
): WarpTransform {
  if (transform.gridSize === gridSize) return cloneWarpTransform(transform);
  const evaluator = createWarpEvaluator(transform);
  const candidate = {
    version: 1 as const,
    gridSize,
    points: createIdentityWarpPoints(gridSize).map((point) =>
      normalizePoint(evaluator.map(point)),
    ),
  };
  if (!isValidWarpTransform(candidate)) {
    throw new RangeError("Resampled warp would be unsafe.");
  }
  return candidate;
}

export function resetWarpPointIndexes(
  transform: WarpTransform,
  indexes: readonly number[],
): WarpTransform {
  const selected = new Set(indexes);
  const identity = createIdentityWarpPoints(transform.gridSize);
  const points = transform.points.map((point, index) =>
    selected.has(index) ? { ...identity[index] } : { ...point },
  );
  return { ...transform, points };
}

function cloneWarpTransform(transform: WarpTransform): WarpTransform {
  return {
    version: 1,
    gridSize: transform.gridSize,
    points: transform.points.map((point) => ({ ...point })),
  };
}

function applyPreset(name: WarpPresetName, point: Point): Point {
  const centeredX = point.x - 0.5;
  const centeredY = point.y - 0.5;
  const horizontalEnvelope = Math.sin(Math.PI * point.x);
  const verticalEnvelope = Math.sin(Math.PI * point.y);
  switch (name) {
    case "archUp":
      return { x: point.x, y: point.y - 0.22 * horizontalEnvelope };
    case "archDown":
      return { x: point.x, y: point.y + 0.22 * horizontalEnvelope };
    case "bulge": {
      const scale = 1 + 0.24 * horizontalEnvelope * verticalEnvelope;
      return { x: 0.5 + centeredX * scale, y: 0.5 + centeredY * scale };
    }
    case "squeeze": {
      const scale = 1 - 0.22 * horizontalEnvelope * verticalEnvelope;
      return { x: 0.5 + centeredX * scale, y: 0.5 + centeredY * scale };
    }
    case "flag":
      return {
        x: point.x,
        y:
          point.y +
          0.13 * Math.sin(Math.PI * 2 * point.x) * (0.72 + point.y * 0.28),
      };
    case "wave":
      return {
        x:
          point.x +
          0.035 * Math.sin(Math.PI * 2 * point.y) * horizontalEnvelope,
        y: point.y + 0.12 * Math.sin(Math.PI * 2 * point.x),
      };
  }
}

function isWarpGridSize(value: number): value is WarpGridSize {
  return value === 3 || value === 5;
}

function isFinitePoint(value: Point | null | undefined): value is Point {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y));
}

function isPointWithinBounds(point: Point): boolean {
  return (
    point.x >= MIN_BLOCK_LOCAL_COORDINATE &&
    point.x <= MAX_BLOCK_LOCAL_COORDINATE &&
    point.y >= MIN_BLOCK_LOCAL_COORDINATE &&
    point.y <= MAX_BLOCK_LOCAL_COORDINATE
  );
}

function resolveWarpPointError(
  points: readonly Point[],
): "non-finite" | "out-of-range" | undefined {
  if (!points.every(isFinitePoint)) return "non-finite";
  return points.every(isPointWithinBounds) ? undefined : "out-of-range";
}

function normalizePoint(point: Point): Point {
  return {
    x: normalizeCoordinate(point.x),
    y: normalizeCoordinate(point.y),
  };
}

function normalizeCoordinate(value: number): number {
  const finite = Number.isFinite(value) ? value : 0;
  const clamped = Math.min(
    MAX_BLOCK_LOCAL_COORDINATE,
    Math.max(MIN_BLOCK_LOCAL_COORDINATE, finite),
  );
  const rounded =
    Math.round((clamped + Number.EPSILON) * PRECISION) / PRECISION;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function invalid(reason: WarpValidationReason): WarpValidationResult {
  return {
    valid: false,
    reason,
    minimumJacobian: 0,
    minimumAxisScale: 0,
  };
}
