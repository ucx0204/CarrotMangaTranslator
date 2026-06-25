import { pixelsToBbox } from "../../shared/geometry";
import type { OverlayItem, RequestSummary } from "./types";

type BBox = { x: number; y: number; w: number; h: number };
type PageSize = { width: number; height: number };

type OcrGeometryLockHint = {
  id: number;
  bbox: BBox;
  label?: string;
  groupId?: string;
  containerType?: string;
};

export function applyOcrCandidateGeometryLocks(
  items: OverlayItem[],
  page: PageSize,
  hints: NonNullable<RequestSummary["ocrBboxHints"]>,
): OverlayItem[] {
  if (hints.length === 0) {
    return items;
  }

  const hintMap = buildOcrGeometryLockHintMap(hints, page);
  if (hintMap.size === 0) {
    return items;
  }

  return items.map((item) => {
    const lockedHint = hintMap.get(item.id);
    if (!lockedHint || !isNearOcrHint(item.bbox, lockedHint.bbox, page)) {
      return item;
    }
    if (isMergedSameContainerOcrItem(item, lockedHint, hintMap)) {
      return item;
    }
    return {
      ...item,
      bbox: lockedHint.bbox,
    };
  });
}

function buildOcrGeometryLockHintMap(
  hints: NonNullable<RequestSummary["ocrBboxHints"]>,
  page: PageSize,
): Map<number, OcrGeometryLockHint> {
  const hintMap = new Map<number, OcrGeometryLockHint>();
  for (const hint of hints) {
    const id = Number(hint.id);
    const x1 = Number(hint.x1);
    const y1 = Number(hint.y1);
    const x2 = Number(hint.x2);
    const y2 = Number(hint.y2);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      ![x1, y1, x2, y2].every(Number.isFinite)
    ) {
      continue;
    }
    hintMap.set(id, {
      id,
      bbox: pixelsToBbox(
        {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
        },
        page.width,
        page.height,
      ),
      label: String(hint.label ?? ""),
      groupId: normalizeReferenceText(hint.groupId),
      containerType: normalizeReferenceText(hint.containerType),
    });
  }
  return hintMap;
}

function isMergedSameContainerOcrItem(
  item: OverlayItem,
  lockedHint: OcrGeometryLockHint,
  hintMap: Map<number, OcrGeometryLockHint>,
): boolean {
  if (
    !lockedHint.groupId ||
    !isMergeableOcrContainerType(lockedHint.containerType)
  ) {
    return false;
  }

  const groupHints = [...hintMap.values()].filter(
    (candidate) =>
      candidate.groupId === lockedHint.groupId &&
      isMergeableOcrContainerType(candidate.containerType),
  );
  if (groupHints.length < 2) {
    return false;
  }

  const unionBbox = unionBboxes(groupHints.map((candidate) => candidate.bbox));
  const itemCoversGroup = bboxContainmentRatio(unionBbox, item.bbox) > 0.72;
  const itemIsWiderThanSingleHint =
    item.bbox.w * item.bbox.h > lockedHint.bbox.w * lockedHint.bbox.h * 1.2;
  return itemCoversGroup && itemIsWiderThanSingleHint;
}

function isMergeableOcrContainerType(value: string | undefined): boolean {
  return normalizeReferenceText(value) === "same_text_container";
}

function unionBboxes(boxes: BBox[]): BBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  };
}

function normalizeReferenceText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
}

function isNearOcrHint(
  modelBbox: BBox,
  hintBbox: BBox,
  page: PageSize,
): boolean {
  const modelPx = normalizedBboxToPixels(modelBbox, page);
  const hintPx = normalizedBboxToPixels(hintBbox, page);
  const modelCenterX = modelPx.x + modelPx.w / 2;
  const modelCenterY = modelPx.y + modelPx.h / 2;
  const hintCenterX = hintPx.x + hintPx.w / 2;
  const hintCenterY = hintPx.y + hintPx.h / 2;
  const distance = Math.hypot(
    modelCenterX - hintCenterX,
    modelCenterY - hintCenterY,
  );
  const tolerance = Math.max(150, Math.max(hintPx.w, hintPx.h) * 1.35);
  return distance <= tolerance || bboxOverlapRatio(modelPx, hintPx) > 0.1;
}

function normalizedBboxToPixels(bbox: BBox, page: PageSize): BBox {
  return {
    x: (bbox.x / 1000) * page.width,
    y: (bbox.y / 1000) * page.height,
    w: (bbox.w / 1000) * page.width,
    h: (bbox.h / 1000) * page.height,
  };
}

function bboxContainmentRatio(a: BBox, b: BBox): number {
  const overlap = bboxIntersectionArea(a, b);
  return overlap / Math.max(1, a.w * a.h);
}

function bboxOverlapRatio(a: BBox, b: BBox): number {
  const overlap = bboxIntersectionArea(a, b);
  const minArea = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
  return overlap / minArea;
}

function bboxIntersectionArea(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}
