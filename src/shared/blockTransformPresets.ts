import type { CurveLayout, PerspectiveTransform, Point } from "./textTypes";

export const MIN_BLOCK_LOCAL_COORDINATE = -4;
export const MAX_BLOCK_LOCAL_COORDINATE = 5;
export const MIN_PERSPECTIVE_EDGE_LENGTH = 0.02;
export const MIN_PERSPECTIVE_AREA = 0.005;
export const MIN_CURVE_CHORD_LENGTH = 0.02;
export const MIN_CURVE_PATH_LENGTH = 0.05;
export const MIN_CURVE_OFFSET_EM = -12;
export const MAX_CURVE_OFFSET_EM = 12;

export const PERSPECTIVE_PRESETS = {
  identity: perspective([point(0, 0), point(1, 0), point(1, 1), point(0, 1)]),
  topNarrow: perspective([
    point(0.16, 0),
    point(0.84, 0),
    point(1, 1),
    point(0, 1),
  ]),
  bottomNarrow: perspective([
    point(0, 0),
    point(1, 0),
    point(0.84, 1),
    point(0.16, 1),
  ]),
  leftNarrow: perspective([
    point(0, 0.16),
    point(1, 0),
    point(1, 1),
    point(0, 0.84),
  ]),
  rightNarrow: perspective([
    point(0, 0),
    point(1, 0.16),
    point(1, 0.84),
    point(0, 1),
  ]),
  skewLeft: perspective([
    point(-0.14, 0),
    point(0.86, 0),
    point(1, 1),
    point(0, 1),
  ]),
  skewRight: perspective([
    point(0.14, 0),
    point(1.14, 0),
    point(1, 1),
    point(0, 1),
  ]),
} satisfies Record<string, PerspectiveTransform>;

export type PerspectivePresetName = keyof typeof PERSPECTIVE_PRESETS;

export const CURVE_PRESETS = {
  straight: curve(point(0, 0.5), point(0.5, 0.5), point(1, 0.5)),
  archUp: curve(point(0, 0.5), point(0.5, -0.25), point(1, 0.5)),
  archDown: curve(point(0, 0.5), point(0.5, 1.25), point(1, 0.5)),
} satisfies Record<string, CurveLayout>;

export type CurvePresetName = keyof typeof CURVE_PRESETS;

/** Return a fresh transform so editor mutations cannot alter a preset. */
export function createPerspectivePreset(
  name: PerspectivePresetName,
): PerspectiveTransform {
  const transform = PERSPECTIVE_PRESETS[name];
  return {
    version: 1,
    corners: transform.corners.map(clonePoint) as [Point, Point, Point, Point],
  };
}

/** Return a fresh layout so editor mutations cannot alter a preset. */
export function createCurvePreset(name: CurvePresetName): CurveLayout {
  const layout = CURVE_PRESETS[name];
  return {
    version: 1,
    path: {
      type: "quadratic",
      start: clonePoint(layout.path.start),
      control: clonePoint(layout.path.control),
      end: clonePoint(layout.path.end),
    },
    alignment: layout.alignment,
    offsetEm: layout.offsetEm,
    orientation: layout.orientation,
  };
}

function point(x: number, y: number): Point {
  return { x, y };
}

function perspective(
  corners: PerspectiveTransform["corners"],
): PerspectiveTransform {
  return { version: 1, corners };
}

function curve(start: Point, control: Point, end: Point): CurveLayout {
  return {
    version: 1,
    path: { type: "quadratic", start, control, end },
    alignment: "center",
    offsetEm: 0,
    orientation: "tangent",
  };
}

function clonePoint(value: Point): Point {
  return { x: value.x, y: value.y };
}
