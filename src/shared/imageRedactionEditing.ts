import type { ImageRedactionStroke } from "./imageRedaction";

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
  if (
    scaling === "exact" &&
    (source.width !== target.width || source.height !== target.height)
  )
    throw new Error(
      "이미지 크기가 다릅니다. 비율 맞추기를 명시적으로 선택해 주세요.",
    );
  const x = target.width / source.width,
    y = target.height / source.height;
  return strokes.map((stroke) => ({
    ...stroke,
    size: Math.max(1, Math.min(4000, stroke.size * Math.min(x, y))),
    points: stroke.points.map((point) => ({
      x: Math.min(target.width, point.x * x),
      y: Math.min(target.height, point.y * y),
    })),
  }));
}
