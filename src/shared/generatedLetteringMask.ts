import { mapPointFromQuad } from "./perspectiveTransformMath";
import { createInverseWarpEvaluator } from "./warpTransformMath";
import type { Point, TranslationBlock, WarpTransform } from "./textTypes";

import type {
  LetteringMaskStroke,
  LetteringTool,
} from "./generatedLetteringMaskTypes";
export const DEFAULT_LETTERING_TOOL: LetteringTool = {
  blockId: null,
  space: "asset",
  mode: "hide",
  shape: "circle",
  size: 24,
  softness: 0,
  showMask: false,
};

/** A page mask is applied outside the lettering's own transforms. */
export function letteringMaskSvg(
  strokes: readonly LetteringMaskStroke[],
  polygons: readonly Point[][] = [],
): string {
  const shapes = polygons
    .map(
      (points) =>
        `<polygon fill="black" points="${points.map((p) => `${p.x},${p.y}`).join(" ")}"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none"><rect width="1000" height="1000" fill="white"/>${shapes}${strokes.map(strokeSvg).join("")}</svg>`;
}

function strokeSvg(stroke: LetteringMaskStroke, index: number): string {
  const color = stroke.mode === "hide" ? "black" : "white";
  const points = stroke.points.map((point) => ({
    x: point.x / stroke.radiusX,
    y: point.y / stroke.radiusY,
  }));
  const first = points[0];
  if (!first) return "";
  const path =
    `M${first.x},${first.y} ` +
    points
      .slice(1)
      .map((point) => `L${point.x},${point.y}`)
      .join(" ");
  const cap = stroke.shape === "circle" ? "round" : "square";
  const dot =
    stroke.shape === "circle"
      ? `<circle cx="${first.x}" cy="${first.y}" r="1" fill="${color}"/>`
      : `<rect x="${first.x - 1}" y="${first.y - 1}" width="2" height="2" fill="${color}"/>`;
  const shapes =
    points.length === 1
      ? dot
      : `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="${cap}" stroke-linejoin="${stroke.shape === "circle" ? "round" : "miter"}"/>`;
  const x = Math.min(...points.map((p) => p.x)) - 2;
  const y = Math.min(...points.map((p) => p.y)) - 2;
  const width = Math.max(...points.map((p) => p.x)) - x + 2;
  const height = Math.max(...points.map((p) => p.y)) - y + 2;
  const filter = stroke.softness
    ? `<defs><filter id="s${index}" filterUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}"><feGaussianBlur stdDeviation="${stroke.softness / 3}"/></filter></defs>`
    : "";
  return `${filter}<g transform="scale(${stroke.radiusX} ${stroke.radiusY})"${stroke.softness ? ` filter="url(#s${index})"` : ""}>${shapes}</g>`;
}

const inverseWarps = new WeakMap<
  WarpTransform,
  ReturnType<typeof createInverseWarpEvaluator>
>();

export function pagePointToLettering(
  point: Point,
  block: TranslationBlock,
  page: { width: number; height: number },
): Point {
  const box = block.renderBbox ?? block.bbox;
  const cx = ((box.x + box.w / 2) * page.width) / 1000;
  const cy = ((box.y + box.h / 2) * page.height) / 1000;
  const angle = (-(block.rotationDeg ?? 0) * Math.PI) / 180;
  const x = (point.x * page.width) / 1000 - cx;
  const y = (point.y * page.height) / 1000 - cy;
  const local = {
    x:
      500 +
      ((x * Math.cos(angle) - y * Math.sin(angle)) * 1000) /
        ((box.w * page.width) / 1000),
    y:
      500 +
      ((x * Math.sin(angle) + y * Math.cos(angle)) * 1000) /
        ((box.h * page.height) / 1000),
  };
  let unit = { x: local.x / 1000, y: local.y / 1000 };
  if (block.perspectiveTransform)
    unit = mapPointFromQuad(unit, block.perspectiveTransform.corners);
  if (block.warpTransform) {
    let evaluator = inverseWarps.get(block.warpTransform);
    if (!evaluator) {
      evaluator = createInverseWarpEvaluator(block.warpTransform);
      inverseWarps.set(block.warpTransform, evaluator);
    }
    unit = evaluator.map(unit);
  }
  return {
    x: Math.max(-10000, Math.min(10000, unit.x * 1000)),
    y: Math.max(-10000, Math.min(10000, unit.y * 1000)),
  };
}
