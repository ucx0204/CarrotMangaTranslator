import {
  createWarpEvaluator,
  mapPointToQuad,
  normalizePerspectiveTransform,
} from "./blockTransforms";
import { normalizeRotationDeg } from "./blockGeometryValues";
import {
  clampTranslationToVisibleBboxes,
  translateBbox,
} from "./bboxTranslation";
import { MIN_VISIBLE_RENDER_BBOX_EXTENT, clampRenderBbox } from "./renderBbox";
import type { BBox, Point, TranslationBlock } from "./textTypes";

type RenderTransformBlock = Pick<
  TranslationBlock,
  "perspectiveTransform" | "rotationDeg" | "warpTransform"
>;

export function constrainEditableRenderBbox(
  block: RenderTransformBlock,
  bbox: BBox,
): BBox {
  const safe = clampRenderBbox(bbox);
  const delta = clampTranslationToVisibleBboxes(
    [resolveTransformedBlockBounds(block, safe)],
    { x: 0, y: 0 },
    MIN_VISIBLE_RENDER_BBOX_EXTENT,
  );
  return clampRenderBbox(translateBbox(safe, delta));
}

export function isEditableBlockVisibleOnPage(
  block: RenderTransformBlock,
  bbox: BBox,
): boolean {
  const bounds = resolveTransformedBlockBounds(block, clampRenderBbox(bbox));
  return (
    bounds.x + bounds.w >= MIN_VISIBLE_RENDER_BBOX_EXTENT &&
    bounds.x <= 1000 - MIN_VISIBLE_RENDER_BBOX_EXTENT &&
    bounds.y + bounds.h >= MIN_VISIBLE_RENDER_BBOX_EXTENT &&
    bounds.y <= 1000 - MIN_VISIBLE_RENDER_BBOX_EXTENT
  );
}

export function resolveTransformedBlockBounds(
  block: RenderTransformBlock,
  bbox: BBox,
): BBox {
  const points = resolveTransformedBlockBoundary(block, bbox);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left,
    y: top,
    w: Math.max(...xs) - left,
    h: Math.max(...ys) - top,
  };
}

/** Ordered page-space boundary used for precise visual hit testing. */
export function resolveTransformedBlockBoundary(
  block: RenderTransformBlock,
  bbox: BBox,
): Point[] {
  const localPoints = resolveLocalTransformedBoundaryPoints(block);
  const center = { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
  const radians = (normalizeRotationDeg(block.rotationDeg) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return localPoints.map((point) => {
    const x = bbox.x + point.x * bbox.w - center.x;
    const y = bbox.y + point.y * bbox.h - center.y;
    return {
      x: center.x + x * cos - y * sin,
      y: center.y + x * sin + y * cos,
    };
  });
}

function resolveLocalTransformedBoundaryPoints(
  block: RenderTransformBlock,
): Point[] {
  const boundary = sampleUnitBoundary(block.warpTransform ? 16 : 1);
  const warp = block.warpTransform
    ? createWarpEvaluator(block.warpTransform)
    : null;
  const perspective = block.perspectiveTransform
    ? normalizePerspectiveTransform(block.perspectiveTransform).corners
    : null;
  return boundary.map((point) => {
    const warped = warp ? warp.map(point) : point;
    return perspective ? mapPointToQuad(warped, perspective) : warped;
  });
}

function sampleUnitBoundary(segments: number): Point[] {
  const points: Point[] = [];
  for (let index = 0; index <= segments; index += 1) {
    points.push({ x: index / segments, y: 0 });
  }
  for (let index = 1; index <= segments; index += 1) {
    points.push({ x: 1, y: index / segments });
  }
  for (let index = 1; index <= segments; index += 1) {
    points.push({ x: 1 - index / segments, y: 1 });
  }
  for (let index = 1; index < segments; index += 1) {
    points.push({ x: 0, y: 1 - index / segments });
  }
  return points;
}
