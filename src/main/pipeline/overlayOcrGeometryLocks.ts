import { bboxOverlapRatio, clamp, pixelsToBbox } from "../../shared/geometry";
import type { OverlayItem, RequestSummary } from "./types";
import {
  bboxContainmentRatio,
  expandBboxToMinimum,
  expandNormalizedBbox,
  inferPhysicalLineCount,
  isPlausibleMergedModelExtent,
} from "./overlayOcrGeometryMath";

type BBox = { x: number; y: number; w: number; h: number };
type PageSize = { width: number; height: number };

type OcrGeometryLockHint = {
  id: number;
  bbox: BBox;
  ocrText?: string;
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

  const claimedCandidateIds = new Set(
    items.flatMap((item) => [item.id, ...(item.candidateIds ?? [])]),
  );
  return items.map((item) => {
    const membershipLocked = lockCandidateMembershipGeometry(
      item,
      hintMap,
      page,
    );
    if (membershipLocked) {
      return membershipLocked;
    }
    const lockedHint = hintMap.get(item.id);
    if (!lockedHint || !isNearOcrHint(item.bbox, lockedHint.bbox, page)) {
      return item;
    }
    const mergedHints = resolveMergedOcrHints(
      item,
      lockedHint,
      hintMap,
      claimedCandidateIds,
      page,
    );
    const physicalLineCount = inferPhysicalLineCount(
      item.bbox,
      lockedHint.bbox,
      page,
      resolveItemDirection(item),
      typeof item.fontSize === "number" ? item.fontSize : undefined,
      sourceLineCount(item),
    );
    if (mergedHints.length > 1 || physicalLineCount > 1) {
      return {
        ...item,
        bbox: buildMergedGlyphBbox(item, mergedHints, page),
      };
    }
    return {
      ...item,
      bbox: lockedHint.bbox,
    };
  });
}

function lockCandidateMembershipGeometry(
  item: OverlayItem,
  hintMap: Map<number, OcrGeometryLockHint>,
  page: PageSize,
): OverlayItem | null {
  if (!Array.isArray(item.candidateIds)) {
    return null;
  }
  if (item.candidateIds.length === 0) {
    return item;
  }
  const memberHints = item.candidateIds.map((id) => hintMap.get(id));
  if (memberHints.some((hint) => !hint)) {
    const error = new Error(
      `Semantic OCR item ${item.id} references an unknown candidate id.`,
    );
    Object.assign(error, {
      code: "semantic-ocr-unknown-candidate",
      itemId: item.id,
      candidateIds: item.candidateIds,
    });
    throw error;
  }
  if (memberHints.length === 1) {
    const memberHint = memberHints[0] as OcrGeometryLockHint;
    const physicalLineCount = inferPhysicalLineCount(
      item.bbox,
      memberHint.bbox,
      page,
      resolveItemDirection(item),
      typeof item.fontSize === "number" ? item.fontSize : undefined,
      sourceLineCount(item),
    );
    if (physicalLineCount === 1) {
      return { ...item, bbox: memberHint.bbox };
    }
  }
  return {
    ...item,
    bbox: buildMergedGlyphBbox(
      item,
      memberHints.map((hint) => hint as OcrGeometryLockHint),
      page,
    ),
  };
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
      ocrText: String(hint.ocrText ?? ""),
      groupId: normalizeReferenceText(hint.groupId),
      containerType: normalizeReferenceText(hint.containerType),
    });
  }
  return hintMap;
}

function resolveMergedOcrHints(
  item: OverlayItem,
  lockedHint: OcrGeometryLockHint,
  hintMap: Map<number, OcrGeometryLockHint>,
  itemIds: Set<number>,
  page: PageSize,
): OcrGeometryLockHint[] {
  const grouped = resolveSameContainerOcrHints(item, lockedHint, hintMap);
  if (grouped.length > 1) {
    return grouped;
  }
  return resolveUngroupedLineHints(item, lockedHint, hintMap, itemIds, page);
}

function resolveSameContainerOcrHints(
  item: OverlayItem,
  lockedHint: OcrGeometryLockHint,
  hintMap: Map<number, OcrGeometryLockHint>,
): OcrGeometryLockHint[] {
  if (
    !lockedHint.groupId ||
    !isMergeableOcrContainerType(lockedHint.containerType)
  ) {
    return [lockedHint];
  }
  const groupHints = [...hintMap.values()].filter(
    (candidate) =>
      candidate.groupId === lockedHint.groupId &&
      isMergeableOcrContainerType(candidate.containerType),
  );
  if (groupHints.length < 2) {
    return [lockedHint];
  }
  const unionBbox = unionBboxes(groupHints.map((candidate) => candidate.bbox));
  const itemCoversGroup = bboxContainmentRatio(unionBbox, item.bbox) > 0.72;
  const itemIsWiderThanSingleHint =
    item.bbox.w * item.bbox.h > lockedHint.bbox.w * lockedHint.bbox.h * 1.2;
  return itemCoversGroup && itemIsWiderThanSingleHint
    ? groupHints
    : [lockedHint];
}

function resolveUngroupedLineHints(
  item: OverlayItem,
  lockedHint: OcrGeometryLockHint,
  hintMap: Map<number, OcrGeometryLockHint>,
  itemIds: Set<number>,
  page: PageSize,
): OcrGeometryLockHint[] {
  const lineCount = inferPhysicalLineCount(
    item.bbox,
    lockedHint.bbox,
    page,
    resolveItemDirection(item),
    typeof item.fontSize === "number" ? item.fontSize : undefined,
    sourceLineCount(item),
  );
  if (lineCount < 2 || lockedHint.groupId) {
    return [lockedHint];
  }
  const selected = [lockedHint];
  const candidates = [...hintMap.values()].filter(
    (candidate) =>
      candidate.id !== lockedHint.id &&
      !candidate.groupId &&
      !itemIds.has(candidate.id) &&
      sourceContainsHintText(item, candidate) &&
      hintBelongsToModelEnvelope(item, candidate, page),
  );
  for (const candidate of candidates) {
    if (selected.length >= lineCount) break;
    if (
      selected.some((member) =>
        areCompatibleLineHints(item, member.bbox, candidate.bbox, page),
      )
    ) {
      selected.push(candidate);
    }
  }
  return selected;
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

function buildMergedGlyphBbox(
  item: OverlayItem,
  hints: OcrGeometryLockHint[],
  page: PageSize,
): BBox {
  const hintUnion = unionBboxes(hints.map((hint) => hint.bbox));
  const merged = isPlausibleMergedModelExtent(item.bbox, hintUnion)
    ? unionBboxes([item.bbox, hintUnion])
    : hintUnion;
  const fontSizePx = Number(item.fontSize);
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) {
    return merged;
  }
  const lineCount = sourceLineCount(item);
  const fontWidth = (fontSizePx / Math.max(1, page.width)) * 1000;
  const fontHeight = (fontSizePx / Math.max(1, page.height)) * 1000;
  const direction = resolveItemDirection(item);
  const minimumWidth =
    direction === "vertical" ? fontWidth * lineCount * 1.05 : fontWidth;
  const minimumHeight =
    direction === "horizontal" ? fontHeight * lineCount * 1.05 : fontHeight;
  const minimum = expandBboxToMinimum(merged, minimumWidth, minimumHeight);
  const paddingPx = clamp(Math.ceil(fontSizePx * 0.18), 2, 8);
  return expandNormalizedBbox(
    minimum,
    (paddingPx / Math.max(1, page.width)) * 1000,
    (paddingPx / Math.max(1, page.height)) * 1000,
  );
}

function sourceLineCount(item: OverlayItem): number {
  const sourceText = String(item.sourceText ?? item.jp ?? "");
  return Math.max(
    1,
    sourceText.split(/\r?\n/).filter((line) => line.trim().length > 0).length,
  );
}

function sourceContainsHintText(
  item: OverlayItem,
  hint: OcrGeometryLockHint,
): boolean {
  const source = normalizeGlyphText(item.sourceText ?? item.jp);
  const candidate = normalizeGlyphText(hint.ocrText);
  return candidate.length > 0 && source.includes(candidate);
}

function normalizeGlyphText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function hintBelongsToModelEnvelope(
  item: OverlayItem,
  hint: OcrGeometryLockHint,
  page: PageSize,
): boolean {
  const fontSizePx =
    Number.isFinite(Number(item.fontSize)) && Number(item.fontSize) > 0
      ? Number(item.fontSize)
      : 12;
  const envelope = expandNormalizedBbox(
    item.bbox,
    ((fontSizePx * 0.5) / Math.max(1, page.width)) * 1000,
    ((fontSizePx * 0.5) / Math.max(1, page.height)) * 1000,
  );
  return bboxContainmentRatio(hint.bbox, envelope) >= 0.72;
}

function areCompatibleLineHints(
  item: OverlayItem,
  left: BBox,
  right: BBox,
  page: PageSize,
): boolean {
  const horizontal = resolveItemDirection(item) === "horizontal";
  const inlineStart = horizontal
    ? Math.max(left.x, right.x)
    : Math.max(left.y, right.y);
  const inlineEnd = horizontal
    ? Math.min(left.x + left.w, right.x + right.w)
    : Math.min(left.y + left.h, right.y + right.h);
  const inlineOverlap = Math.max(0, inlineEnd - inlineStart);
  const inlineExtent = horizontal
    ? Math.min(left.w, right.w)
    : Math.min(left.h, right.h);
  if (inlineOverlap / Math.max(1, inlineExtent) < 0.35) {
    return false;
  }
  const blockStart = horizontal
    ? Math.max(left.y, right.y)
    : Math.max(left.x, right.x);
  const blockEnd = horizontal
    ? Math.min(left.y + left.h, right.y + right.h)
    : Math.min(left.x + left.w, right.x + right.w);
  const gap = Math.max(0, blockStart - blockEnd);
  const fontSizePx =
    Number.isFinite(Number(item.fontSize)) && Number(item.fontSize) > 0
      ? Number(item.fontSize)
      : 20;
  const fontExtent =
    ((fontSizePx * 1.75) / Math.max(1, horizontal ? page.height : page.width)) *
    1000;
  return gap <= fontExtent;
}

function resolveItemDirection(item: OverlayItem): "horizontal" | "vertical" {
  if (item.direction === "horizontal" || item.direction === "vertical") {
    return item.direction;
  }
  return item.bbox.w >= item.bbox.h ? "horizontal" : "vertical";
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
