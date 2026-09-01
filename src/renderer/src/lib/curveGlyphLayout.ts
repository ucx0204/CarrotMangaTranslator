import {
  quadraticPointAt,
  quadraticTangentAt,
} from "../../../shared/blockTransforms";
import type {
  CurveLayout,
  Point,
  QuadraticCurvePath,
} from "../../../shared/textTypes";
import type { TextStyleRun } from "../../../shared/richTextMarkup";

const ARC_SAMPLES = 96;

export type MeasuredCurveGlyph = {
  char: string;
  width: number;
  bold: boolean;
  italic: boolean;
  fontSizePx?: number;
  fontFamily?: string;
  opacity?: number;
  style?: Omit<TextStyleRun, "text">;
};

export type PositionedCurveGlyph = MeasuredCurveGlyph & {
  x: number;
  y: number;
  angleDeg: number;
};

type CurveGlyphLayoutOptions = {
  glyphs: MeasuredCurveGlyph[];
  layout: CurveLayout;
  width: number;
  height: number;
  fontSizePx: number;
  fontWidthScale: number;
  letterSpacingPx: number;
};

type ArcSample = {
  distance: number;
  point: Point;
  tangent: Point;
  t: number;
};

export function layoutGlyphsOnCurve({
  glyphs,
  layout,
  width,
  height,
  fontSizePx,
  fontWidthScale,
  letterSpacingPx,
}: CurveGlyphLayoutOptions): PositionedCurveGlyph[] {
  if (glyphs.length === 0 || width <= 0 || height <= 0) return [];
  const path = resolvePixelPath(layout, width, height);
  const samples = buildArcSamples(path);
  const pathLength = samples.at(-1)?.distance ?? 0;
  const widths = glyphs.map(
    (glyph) => glyph.width * fontWidthScale * (glyph.style?.widthScale ?? 1),
  );
  const gap = resolveGlyphGap(
    layout.fitSpacing === true,
    pathLength,
    widths,
    letterSpacingPx,
  );
  const totalWidth = sum(widths) + Math.max(0, glyphs.length - 1) * gap;
  let cursor = alignmentOffset(layout.alignment, pathLength, totalWidth);
  const offsetPx = layout.offsetEm * fontSizePx;

  return glyphs.map((glyph, index) => {
    const widthPx = widths[index];
    const sample = sampleAtDistance(samples, cursor + widthPx / 2);
    cursor += widthPx + gap;
    return {
      ...glyph,
      width: widthPx,
      x: sample.point.x - sample.tangent.y * offsetPx,
      y: sample.point.y + sample.tangent.x * offsetPx,
      angleDeg:
        layout.orientation === "tangent"
          ? (Math.atan2(sample.tangent.y, sample.tangent.x) * 180) / Math.PI
          : 0,
    };
  });
}

function resolvePixelPath(
  layout: CurveLayout,
  width: number,
  height: number,
): QuadraticCurvePath {
  const start = layout.reversed ? layout.path.end : layout.path.start;
  const end = layout.reversed ? layout.path.start : layout.path.end;
  return {
    type: "quadratic",
    start: scalePoint(start, width, height),
    control: scalePoint(layout.path.control, width, height),
    end: scalePoint(end, width, height),
  };
}

function buildArcSamples(path: QuadraticCurvePath): ArcSample[] {
  const result: ArcSample[] = [];
  let distance = 0;
  let previous = quadraticPointAt(path, 0);
  for (let index = 0; index <= ARC_SAMPLES; index += 1) {
    const t = index / ARC_SAMPLES;
    const point = quadraticPointAt(path, t);
    if (index > 0)
      distance += Math.hypot(point.x - previous.x, point.y - previous.y);
    result.push({
      distance,
      point,
      tangent: quadraticTangentAt(path, t),
      t,
    });
    previous = point;
  }
  return result;
}

function sampleAtDistance(samples: ArcSample[], distance: number): ArcSample {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (distance <= 0) return extrapolate(first, distance);
  if (distance >= last.distance) {
    return extrapolate(last, distance - last.distance);
  }
  const nextIndex = findUpperSample(samples, distance);
  const before = samples[nextIndex - 1];
  const after = samples[nextIndex];
  const span = Math.max(Number.EPSILON, after.distance - before.distance);
  const ratio = (distance - before.distance) / span;
  const point = interpolatePoint(before.point, after.point, ratio);
  const tangent = quadraticTangentAtPoint(before, after, ratio);
  return {
    distance,
    point,
    tangent,
    t: before.t + (after.t - before.t) * ratio,
  };
}

function findUpperSample(samples: ArcSample[], distance: number): number {
  let low = 1;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].distance < distance) low = middle + 1;
    else high = middle;
  }
  return low;
}

function extrapolate(sample: ArcSample, delta: number): ArcSample {
  return {
    ...sample,
    point: {
      x: sample.point.x + sample.tangent.x * delta,
      y: sample.point.y + sample.tangent.y * delta,
    },
  };
}

function quadraticTangentAtPoint(
  before: ArcSample,
  after: ArcSample,
  ratio: number,
): Point {
  const value = interpolatePoint(before.tangent, after.tangent, ratio);
  const magnitude = Math.hypot(value.x, value.y);
  return magnitude > Number.EPSILON
    ? { x: value.x / magnitude, y: value.y / magnitude }
    : { x: 1, y: 0 };
}

function resolveGlyphGap(
  fitSpacing: boolean,
  pathLength: number,
  widths: number[],
  naturalGap: number,
): number {
  if (!fitSpacing || widths.length < 2 || pathLength < sum(widths)) {
    return naturalGap;
  }
  return (pathLength - sum(widths)) / (widths.length - 1);
}

function alignmentOffset(
  alignment: CurveLayout["alignment"],
  pathLength: number,
  textWidth: number,
): number {
  if (alignment === "start") return 0;
  if (alignment === "end") return pathLength - textWidth;
  return (pathLength - textWidth) / 2;
}

function scalePoint(point: Point, width: number, height: number): Point {
  return { x: point.x * width, y: point.y * height };
}

function interpolatePoint(a: Point, b: Point, ratio: number): Point {
  return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
