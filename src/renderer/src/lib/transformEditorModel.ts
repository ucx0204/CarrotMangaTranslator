import type {
  BBox,
  CurveLayout,
  PerspectiveTransform,
  Point,
  TranslationBlock,
  WarpTransform,
} from "../../../shared/textTypes";
import {
  normalizeRotationDeg,
  resolveEditableBlockBbox,
  resolveFontWidthScale,
} from "./blockFormatGeometry";
import {
  createWarpEvaluator,
  mapPointToQuad,
  normalizePerspectiveTransform,
  quadraticLength,
} from "../../../shared/blockTransforms";

export type PageSize = { width: number; height: number };
export type BboxField = "x" | "y" | "w" | "h";

export function resolveTransformBbox(
  block: TranslationBlock,
  pageSize: PageSize,
): BBox {
  return resolveEditableBlockBbox(
    block,
    pageSize,
    block.translatedText || block.sourceText || "...",
  ).bbox;
}

export function bboxFieldToPixels(
  bbox: BBox,
  field: BboxField,
  pageSize: PageSize,
): number {
  const dimension =
    field === "x" || field === "w" ? pageSize.width : pageSize.height;
  return Math.round((bbox[field] / 1000) * dimension);
}

export function updateBboxFromPixels({
  bbox,
  field,
  lockRatio,
  pageSize,
  value,
}: {
  bbox: BBox;
  field: BboxField;
  lockRatio: boolean;
  pageSize: PageSize;
  value: number;
}): BBox {
  const dimension =
    field === "x" || field === "w" ? pageSize.width : pageSize.height;
  const normalized = (value / Math.max(1, dimension)) * 1000;
  if (field === "x") {
    return { ...bbox, x: clampValue(normalized, 0, 1000 - bbox.w) };
  }
  if (field === "y") {
    return { ...bbox, y: clampValue(normalized, 0, 1000 - bbox.h) };
  }
  if (!lockRatio) {
    const maximum = field === "w" ? 1000 - bbox.x : 1000 - bbox.y;
    return { ...bbox, [field]: clampValue(normalized, 1, maximum) };
  }
  const current = field === "w" ? bbox.w : bbox.h;
  const minimumScale = Math.max(1 / bbox.w, 1 / bbox.h);
  const maximumScale = Math.min(
    (1000 - bbox.x) / bbox.w,
    (1000 - bbox.y) / bbox.h,
  );
  const scale = clampValue(
    normalized / Math.max(Number.EPSILON, current),
    minimumScale,
    maximumScale,
  );
  return { ...bbox, w: bbox.w * scale, h: bbox.h * scale };
}

export function bboxFieldMaximumPixels(
  bbox: BBox,
  field: BboxField,
  pageSize: PageSize,
  lockRatio: boolean,
): number {
  const xPx = (bbox.x / 1000) * pageSize.width;
  const yPx = (bbox.y / 1000) * pageSize.height;
  const widthPx = (bbox.w / 1000) * pageSize.width;
  const heightPx = (bbox.h / 1000) * pageSize.height;
  if (field === "x") return Math.max(0, pageSize.width - widthPx);
  if (field === "y") return Math.max(0, pageSize.height - heightPx);
  if (!lockRatio) {
    return field === "w" ? pageSize.width - xPx : pageSize.height - yPx;
  }
  const maximumScale = Math.min(
    (1000 - bbox.x) / bbox.w,
    (1000 - bbox.y) / bbox.h,
  );
  return (field === "w" ? widthPx : heightPx) * maximumScale;
}

export function isPerspectiveVisibleOnPage(
  block: TranslationBlock,
  transform: PerspectiveTransform,
  pageSize: PageSize,
): boolean {
  const bbox = resolveTransformBbox(block, pageSize);
  const center = { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
  const radians = (normalizeRotationDeg(block.rotationDeg) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points = transform.corners.map((corner) => {
    const x = bbox.x + corner.x * bbox.w - center.x;
    const y = bbox.y + corner.y * bbox.h - center.y;
    return {
      x: center.x + x * cos - y * sin,
      y: center.y + x * sin + y * cos,
    };
  });
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return (
    Math.max(...xs) > 0 &&
    Math.min(...xs) < 1000 &&
    Math.max(...ys) > 0 &&
    Math.min(...ys) < 1000
  );
}

export function isWarpVisibleOnPage(
  block: TranslationBlock,
  transform: WarpTransform,
  pageSize: PageSize,
): boolean {
  const evaluator = createWarpEvaluator(transform);
  const perspective = block.perspectiveTransform
    ? normalizePerspectiveTransform(block.perspectiveTransform).corners
    : null;
  const samples: Point[] = [];
  for (let row = 0; row <= 16; row += 1) {
    for (let column = 0; column <= 16; column += 1) {
      if (row !== 0 && row !== 16 && column !== 0 && column !== 16) continue;
      const warped = evaluator.map({ x: column / 16, y: row / 16 });
      samples.push(perspective ? mapPointToQuad(warped, perspective) : warped);
    }
  }
  return areLocalPointsVisibleOnPage(block, samples, pageSize);
}

function areLocalPointsVisibleOnPage(
  block: TranslationBlock,
  localPoints: readonly Point[],
  pageSize: PageSize,
): boolean {
  const bbox = resolveTransformBbox(block, pageSize);
  const center = { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
  const radians = (normalizeRotationDeg(block.rotationDeg) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points = localPoints.map((point) => {
    const x = bbox.x + point.x * bbox.w - center.x;
    const y = bbox.y + point.y * bbox.h - center.y;
    return {
      x: center.x + x * cos - y * sin,
      y: center.y + x * sin + y * cos,
    };
  });
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return (
    Math.max(...xs) > 0 &&
    Math.min(...xs) < 1000 &&
    Math.max(...ys) > 0 &&
    Math.min(...ys) < 1000
  );
}

export function resolveCurveBend(curve: CurveLayout): number {
  const { start, control, end } = curve.path;
  const { midpoint, normal } = resolveChord(start, end);
  const signed =
    (control.x - midpoint.x) * normal.x + (control.y - midpoint.y) * normal.y;
  return Math.round(-signed * 100);
}

export function updateCurveBend(curve: CurveLayout, bend: number): CurveLayout {
  const { midpoint, normal } = resolveChord(curve.path.start, curve.path.end);
  const distance = -bend / 100;
  return {
    ...curve,
    path: {
      ...curve.path,
      control: {
        x: midpoint.x + normal.x * distance,
        y: midpoint.y + normal.y * distance,
      },
    },
  };
}

export function resolveCurveConstraint(
  block: TranslationBlock,
): "vertical" | "multiline" | null {
  if (block.renderDirection === "vertical") return "vertical";
  const text = block.translatedText || block.sourceText || "";
  return /[\r\n]/.test(text) ? "multiline" : null;
}

export function estimateCurveOverflowPx(
  block: TranslationBlock,
  bbox: BBox,
  pageSize: PageSize,
): number {
  const curve = block.curveLayout;
  if (!curve) return 0;
  const estimate = resolveCurveLengthEstimate(block, curve, bbox, pageSize);
  if (curve.fitSpacing && estimate.pathLength >= estimate.glyphWidth) {
    return 0;
  }
  return Math.max(
    0,
    Math.round(estimate.naturalTextLength - estimate.pathLength),
  );
}

export function canFitCurveSpacing(
  block: TranslationBlock,
  bbox: BBox,
  pageSize: PageSize,
): boolean {
  const curve = block.curveLayout;
  if (!curve) return false;
  const estimate = resolveCurveLengthEstimate(block, curve, bbox, pageSize);
  return estimate.glyphCount > 1 && estimate.pathLength >= estimate.glyphWidth;
}

function resolveCurveLengthEstimate(
  block: TranslationBlock,
  curve: CurveLayout,
  bbox: BBox,
  pageSize: PageSize,
): {
  glyphCount: number;
  glyphWidth: number;
  naturalTextLength: number;
  pathLength: number;
} {
  const path = scaleCurvePath(curve, bbox, pageSize);
  const pathLength = quadraticLength(path);
  const text = [...(block.translatedText || block.sourceText || "")].length;
  const spacing = (block.letterSpacing ?? 0) * block.fontSizePx;
  const glyphAdvance =
    block.fontSizePx * 0.9 * resolveFontWidthScale(block.fontWidthScale);
  const glyphWidth = text * glyphAdvance;
  return {
    glyphCount: text,
    glyphWidth,
    naturalTextLength: glyphWidth + Math.max(0, text - 1) * spacing,
    pathLength,
  };
}

function scaleCurvePath(
  curve: CurveLayout,
  bbox: BBox,
  pageSize: PageSize,
): CurveLayout["path"] {
  const width = (bbox.w / 1000) * pageSize.width;
  const height = (bbox.h / 1000) * pageSize.height;
  const scale = (point: Point): Point => ({
    x: point.x * width,
    y: point.y * height,
  });
  return {
    type: "quadratic",
    start: scale(curve.path.start),
    control: scale(curve.path.control),
    end: scale(curve.path.end),
  };
}

function resolveChord(
  start: Point,
  end: Point,
): { midpoint: Point; normal: Point } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(0.001, Math.hypot(dx, dy));
  return {
    midpoint: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    normal: { x: -dy / length, y: dx / length },
  };
}

function clampValue(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
