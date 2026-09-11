import {
  MAX_REDACTION_ISOLATION_DEPTH,
  type ImageRedactionStroke,
} from "./imageRedaction";
import { assertRedactionCopyCompatible } from "./imageRedactionCopyPolicy";

type Size = { width: number; height: number };
export type RedactionBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function redactionStrokeBounds(
  stroke: ImageRedactionStroke,
): RedactionBounds {
  const padding = stroke.shape === "rectangle" ? 0 : stroke.size / 2;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const point of stroke.points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  if (!stroke.points.length) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  };
}

export function moveRedactionStroke(
  stroke: ImageRedactionStroke,
  dx: number,
  dy: number,
  page: Size,
): ImageRedactionStroke {
  const bounds = redactionStrokeBounds(stroke);
  const padding = stroke.shape === "rectangle" ? 0 : stroke.size / 2;
  const x = Math.max(
    -bounds.x - padding,
    Math.min(page.width - bounds.x - bounds.width + padding, dx),
  );
  const y = Math.max(
    -bounds.y - padding,
    Math.min(page.height - bounds.y - bounds.height + padding, dy),
  );
  return {
    ...stroke,
    points: stroke.points.map((point) => ({ x: point.x + x, y: point.y + y })),
  };
}

export function resizeRedactionRectangle(
  stroke: ImageRedactionStroke,
  point: { x: number; y: number },
  page: Size,
): ImageRedactionStroke {
  if (stroke.shape !== "rectangle") return stroke;
  const bounds = redactionStrokeBounds(stroke);
  return {
    ...stroke,
    points: [
      { x: bounds.x, y: bounds.y },
      {
        x: Math.max(bounds.x + 1, Math.min(page.width, point.x)),
        y: Math.max(bounds.y + 1, Math.min(page.height, point.y)),
      },
    ],
  };
}

export function hitRedactionStroke(
  strokes: readonly ImageRedactionStroke[],
  point: { x: number; y: number },
): number {
  for (let index = strokes.length - 1; index >= 0; index--) {
    const bounds = redactionStrokeBounds(strokes[index]);
    if (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    )
      return index;
  }
  return -1;
}

/** Scaling is an explicit user choice; all copied pages require another review. */
export function copyRedactionStrokes(
  strokes: readonly ImageRedactionStroke[],
  source: Size,
  target: Size,
  scaling: "exact" | "proportional",
): ImageRedactionStroke[] {
  assertRedactionCopyCompatible(strokes, source, target, scaling);
  const factor = target.width / source.width;
  return strokes.map((stroke) => ({
    ...stroke,
    size: stroke.shape === "rectangle" ? stroke.size : stroke.size * factor,
    points: stroke.points.map((point) => ({
      x: Math.min(target.width, point.x * factor),
      y: Math.min(target.height, point.y * factor),
    })),
  }));
}

/** Add a completed source mask, not its erase commands, to the existing mask.
 * A later unscoped eraser still edits the combined result. Nested copies retain
 * their own isolation; a common outer group is redundant on an empty source.
 */
export function mergeRedactionStrokes(
  existing: readonly ImageRedactionStroke[],
  copied: readonly ImageRedactionStroke[],
  replace: boolean,
): ImageRedactionStroke[] {
  if (replace || !existing.length) return [...copied];
  if (!copied.length) return [...existing];
  if (!copied.some((stroke) => stroke.operation === "restore"))
    return [...existing, ...copied];
  const group =
    Math.max(0, ...existing.map((stroke) => stroke.isolation?.[0] ?? 0)) + 1;
  const first = copied[0].isolation ?? [];
  let common = 0;
  while (
    common < first.length &&
    copied.every((stroke) => stroke.isolation?.[common] === first[common])
  )
    common++;
  const isolated = copied.map((stroke) => {
    const isolation = [group, ...(stroke.isolation?.slice(common) ?? [])];
    if (isolation.length > MAX_REDACTION_ISOLATION_DEPTH || group > 2147483647)
      throw new Error(
        "The nested mask copy limit was exceeded; the existing mask is unchanged",
      );
    return { ...stroke, isolation };
  });
  return [...existing, ...isolated];
}

/** Compare edit values rather than object identity or property insertion order. */
export function redactionStrokesEqual(
  left: readonly ImageRedactionStroke[],
  right: readonly ImageRedactionStroke[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((stroke, index) => {
        const other = right[index];
        const isolation = stroke.isolation ?? [];
        const otherIsolation = other.isolation ?? [];
        return (
          stroke.shape === other.shape &&
          (stroke.operation ?? "hide") === (other.operation ?? "hide") &&
          stroke.size === other.size &&
          isolation.length === otherIsolation.length &&
          isolation.every((group, depth) => group === otherIsolation[depth]) &&
          stroke.points.length === other.points.length &&
          stroke.points.every(
            (point, pointIndex) =>
              point.x === other.points[pointIndex].x &&
              point.y === other.points[pointIndex].y,
          )
        );
      }))
  );
}
