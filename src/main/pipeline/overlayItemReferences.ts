import { clampBbox, pixelsToBbox } from "../../shared/geometry";
import type { BBox, MangaPage } from "../../shared/types";
import type {
  BboxNormalizationOptions,
  OverlayItem,
  RequestSummary,
  TranslationResult,
} from "./types";
import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import {
  hasPixelCoordinateEvidence,
  inferDetectedBboxSpace,
} from "./overlayBboxSpace";

export type OverlayValidationResult = {
  items: OverlayItem[];
  droppedCount: number;
  reasons: Record<string, number>;
};

export function validateOverlayItemsAgainstReferences(
  items: OverlayItem[],
  page: MangaPage,
  hints: NonNullable<RequestSummary["ocrBboxHints"]>,
  _previousBlocks: PreviousOverlayBlockForPrompt[] = [],
): OverlayValidationResult {
  const candidateBoxes = buildCandidateReferenceBoxes(hints, page);
  const candidateIds = new Set(candidateBoxes.map((candidate) => candidate.id));
  const accepted: OverlayItem[] = [];
  const reasons: Record<string, number> = {};

  for (const item of items) {
    const reason = resolveOverlayDropReason(
      item,
      accepted,
      candidateBoxes,
      candidateIds,
    );
    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      continue;
    }
    accepted.push(item);
  }

  return {
    items: accepted,
    droppedCount: items.length - accepted.length,
    reasons,
  };
}

export function normalizeOverlayItemBboxes(
  items: OverlayItem[],
  page: MangaPage,
  options: BboxNormalizationOptions = {},
): OverlayItem[] {
  const bboxSpace =
    options.coordinateSpace ?? inferDetectedBboxSpace(items, page);
  const pixelWidth =
    options.pixelWidth && options.pixelWidth > 0
      ? options.pixelWidth
      : page.width;
  const pixelHeight =
    options.pixelHeight && options.pixelHeight > 0
      ? options.pixelHeight
      : page.height;
  const fontSizeScale =
    bboxSpace === "pixels"
      ? Math.max(page.width / pixelWidth, page.height / pixelHeight)
      : 1;
  return items.map((item) => {
    const itemBboxSpace =
      bboxSpace === "normalized_1000" &&
      hasPixelCoordinateEvidence(item.bbox, page)
        ? "pixels"
        : bboxSpace;
    return {
      ...item,
      bbox:
        itemBboxSpace === "pixels"
          ? pixelsToBbox(item.bbox, pixelWidth, pixelHeight)
          : clampBbox(item.bbox),
      fontSize:
        itemBboxSpace === "pixels" &&
        typeof item.fontSize === "number" &&
        Number.isFinite(item.fontSize)
          ? Math.max(1, Math.round(item.fontSize * fontSizeScale))
          : item.fontSize,
    };
  });
}

export function getBboxNormalizationOptions(
  requestBody: TranslationResult["requestBody"],
): BboxNormalizationOptions {
  if (!requestBody || typeof requestBody !== "object") {
    return {};
  }

  const summary = requestBody as RequestSummary;
  if (summary.bboxCoordinateSpace !== "pixels") {
    return {};
  }

  return {
    coordinateSpace: "pixels",
    pixelWidth: Number(summary.bboxCoordinateFrame?.width),
    pixelHeight: Number(summary.bboxCoordinateFrame?.height),
  };
}

export function getOcrBboxHints(
  requestBody: TranslationResult["requestBody"],
): NonNullable<RequestSummary["ocrBboxHints"]> {
  if (!requestBody || typeof requestBody !== "object") {
    return [];
  }
  const hints = (requestBody as RequestSummary).ocrBboxHints;
  return Array.isArray(hints) ? hints : [];
}

export function applyOcrCandidateGeometryLocks(
  items: OverlayItem[],
  page: MangaPage,
  hints: NonNullable<RequestSummary["ocrBboxHints"]>,
): OverlayItem[] {
  if (hints.length === 0) {
    return items;
  }

  const hintMap = new Map<number, CandidateReferenceBox>();
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

type CandidateReferenceBox = {
  id: number;
  bbox: BBox;
  label?: string;
  groupId?: string;
  containerType?: string;
};

function resolveOverlayDropReason(
  item: OverlayItem,
  accepted: OverlayItem[],
  candidateBoxes: CandidateReferenceBox[],
  candidateIds: Set<number>,
): string | null {
  if (isFragmentNoise(item.jp, item.ko)) {
    return "fragment_noise";
  }
  if (isMergedUiListBlock(item)) {
    return "merged_ui_list";
  }
  if (accepted.some((candidate) => candidate.id === item.id)) {
    return "duplicate_id";
  }
  if (
    candidateIds.size > 0 &&
    !candidateIds.has(item.id) &&
    isNewIdOverlappingCandidate(item, candidateBoxes)
  ) {
    return "new_id_overlaps_ocr_candidate";
  }
  if (accepted.some((candidate) => isDuplicatePhysicalText(item, candidate))) {
    return "duplicate_physical_text";
  }
  return null;
}

function buildCandidateReferenceBoxes(
  hints: NonNullable<RequestSummary["ocrBboxHints"]>,
  page: MangaPage,
): CandidateReferenceBox[] {
  const boxes: CandidateReferenceBox[] = [];
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
    boxes.push({
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
  return boxes;
}

function isMergedSameContainerOcrItem(
  item: OverlayItem,
  lockedHint: CandidateReferenceBox,
  hintMap: Map<number, CandidateReferenceBox>,
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

function isFragmentNoise(jp: string, ko: string): boolean {
  const source = jp.replace(/\s+/g, "");
  const target = ko.replace(/\s+/g, "");

  if (!source) {
    return true;
  }
  if (/^[.。．・…⋯･\-‐‑–—―ー~〜～_＿]+$/.test(source)) {
    return true;
  }

  const hasJapanese = /[぀-ヿ㐀-䶿一-鿿豈-﫿々ー]/.test(source);
  if (!hasJapanese && source.length <= 3) {
    return true;
  }
  return /^[.。．・…⋯･\-‐‑–—―~〜～_＿]+$/.test(target);
}

function isMergedUiListBlock(item: OverlayItem): boolean {
  const source = item.jp.replace(/\s+/g, " ").trim();
  if (!source) {
    return false;
  }
  const area = item.bbox.w * item.bbox.h;
  if (area < 36000) {
    return false;
  }
  const rowLikeCount = (source.match(/\b\d{1,2}\b/g) || []).length;
  const hasUiKeyword = /\b(MENU|SAVE|DELETE|QUESTS?)\b/i.test(source);
  const hasJapaneseListPunctuation = /[：:]/.test(source);
  return rowLikeCount >= 4 && (hasUiKeyword || hasJapaneseListPunctuation);
}

function isNewIdOverlappingCandidate(
  item: OverlayItem,
  candidateBoxes: CandidateReferenceBox[],
): boolean {
  return candidateBoxes.some((candidate) => {
    return (
      centerInsideBbox(item.bbox, candidate.bbox) ||
      centerInsideBbox(candidate.bbox, item.bbox) ||
      bboxOverlapRatio(item.bbox, candidate.bbox) > 0.1 ||
      bboxContainmentRatio(item.bbox, candidate.bbox) > 0.5
    );
  });
}

function isDuplicatePhysicalText(
  item: OverlayItem,
  accepted: OverlayItem,
): boolean {
  if (!areBboxesNear(item.bbox, accepted.bbox)) {
    return false;
  }
  const source = normalizeComparableText(item.jp);
  const acceptedSource = normalizeComparableText(accepted.jp);
  if (source && acceptedSource && source === acceptedSource) {
    return true;
  }
  const target = normalizeComparableText(item.ko);
  const acceptedTarget = normalizeComparableText(accepted.ko);
  return Boolean(target && acceptedTarget && target === acceptedTarget);
}

function normalizeComparableText(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/["'“”‘’「」『』（）()[\]{}]/g, "")
    .trim()
    .toLowerCase();
}

function areBboxesNear(a: BBox, b: BBox): boolean {
  const distance = Math.hypot(
    a.x + a.w / 2 - (b.x + b.w / 2),
    a.y + a.h / 2 - (b.y + b.h / 2),
  );
  return (
    bboxOverlapRatio(a, b) > 0.08 ||
    distance <= Math.max(24, Math.max(a.w, a.h, b.w, b.h) * 0.45)
  );
}

function centerInsideBbox(inner: BBox, outer: BBox): boolean {
  const centerX = inner.x + inner.w / 2;
  const centerY = inner.y + inner.h / 2;
  return (
    centerX >= outer.x &&
    centerX <= outer.x + outer.w &&
    centerY >= outer.y &&
    centerY <= outer.y + outer.h
  );
}

function bboxContainmentRatio(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const area = Math.max(1, a.w * a.h);
  return overlap / area;
}

function isNearOcrHint(
  modelBbox: BBox,
  hintBbox: BBox,
  page: MangaPage,
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

function normalizedBboxToPixels(bbox: BBox, page: MangaPage): BBox {
  return {
    x: (bbox.x / 1000) * page.width,
    y: (bbox.y / 1000) * page.height,
    w: (bbox.w / 1000) * page.width,
    h: (bbox.h / 1000) * page.height,
  };
}

function bboxOverlapRatio(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const minArea = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
  return overlap / minArea;
}
