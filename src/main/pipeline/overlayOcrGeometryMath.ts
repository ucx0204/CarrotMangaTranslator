type BBox = { x: number; y: number; w: number; h: number };

export function expandBboxToMinimum(
  bbox: BBox,
  minimumWidth: number,
  minimumHeight: number,
): BBox {
  const width = Math.max(bbox.w, minimumWidth);
  const height = Math.max(bbox.h, minimumHeight);
  return {
    x: bbox.x - (width - bbox.w) / 2,
    y: bbox.y - (height - bbox.h) / 2,
    w: width,
    h: height,
  };
}

export function expandNormalizedBbox(
  bbox: BBox,
  paddingX: number,
  paddingY: number,
): BBox {
  const x1 = clamp(bbox.x - paddingX, 0, 1000);
  const y1 = clamp(bbox.y - paddingY, 0, 1000);
  const x2 = clamp(bbox.x + bbox.w + paddingX, x1, 1000);
  const y2 = clamp(bbox.y + bbox.h + paddingY, y1, 1000);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function bboxContainmentRatio(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  return intersection / Math.max(1, a.w * a.h);
}

export function isPlausibleMergedModelExtent(
  modelBbox: BBox,
  hintUnion: BBox,
): boolean {
  const modelArea = Math.max(1, modelBbox.w * modelBbox.h);
  const hintArea = Math.max(1, hintUnion.w * hintUnion.h);
  if (modelArea > hintArea * 8) {
    return false;
  }
  const centerDistance = Math.hypot(
    modelBbox.x + modelBbox.w / 2 - (hintUnion.x + hintUnion.w / 2),
    modelBbox.y + modelBbox.h / 2 - (hintUnion.y + hintUnion.h / 2),
  );
  const nearbyExtent =
    Math.max(modelBbox.w, modelBbox.h, hintUnion.w, hintUnion.h) * 1.75;
  return (
    bboxContainmentRatio(hintUnion, modelBbox) >= 0.55 ||
    bboxContainmentRatio(modelBbox, hintUnion) >= 0.15 ||
    centerDistance <= nearbyExtent
  );
}

export function inferPhysicalLineCount(
  modelBbox: BBox,
  hintBbox: BBox,
  page: { width: number; height: number },
  direction: "horizontal" | "vertical",
  fontSizePx: number | undefined,
  declaredLineCount: number,
): number {
  const horizontal = direction === "horizontal";
  const pageExtent = Math.max(1, horizontal ? page.height : page.width);
  const modelExtent =
    ((horizontal ? modelBbox.h : modelBbox.w) / 1000) * pageExtent;
  const hintExtent =
    ((horizontal ? hintBbox.h : hintBbox.w) / 1000) * pageExtent;
  const fontExtent =
    fontSizePx && Number.isFinite(fontSizePx) && fontSizePx > 0
      ? fontSizePx
      : hintExtent;
  const inferred = Math.min(
    6,
    Math.max(
      1,
      Math.round(
        modelExtent / Math.max(1, fontExtent * 1.05, hintExtent * 0.9),
      ),
    ),
  );
  return Math.max(declaredLineCount, inferred);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
