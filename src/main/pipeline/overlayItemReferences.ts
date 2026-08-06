import {
  bboxOverlapRatio,
  clampBbox,
  pixelsToBbox,
} from "../../shared/geometry";
import type { BBox } from "../../shared/textTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type {
  BboxNormalizationOptions,
  OverlayItem,
  RequestSummary,
  TranslationResult,
} from "./types";
import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import { isJapaneseLanguageCode } from "../../shared/translationLanguages";
import {
  hasPixelCoordinateEvidence,
  inferDetectedBboxSpace,
} from "./overlayBboxSpace";
import { computeOmittedCandidateIds } from "./overlayCompletenessGap";

export type OverlayValidationResult = {
  items: OverlayItem[];
  droppedCount: number;
  reasons: Record<string, number>;
  remappedCount: number;
  omittedCandidateIds: number[];
};

export type OverlayValidationOptions = {
  regionCropMode?: boolean;
  sourceLanguage?: string;
};

// normalized_1000 bbox 공간(검증 시점) 기준 면적 임계값. 대사 버블은 ~100x200=20,000,
// 루비/작은 인접 중복은 ~20x20=400 부근. "큰 덩어리는 살리고 루비는 중복 제거"를 위한 값.
const LARGE_ORDINARY_AREA = 12000;
const SMALL_DUPLICATE_AREA = 4000;
const STRONG_OVERLAP_CONTAINMENT = 0.8;

export function validateOverlayItemsAgainstReferences(
  items: OverlayItem[],
  page: MangaPage,
  hints: NonNullable<RequestSummary["ocrBboxHints"]>,
  _previousBlocks: PreviousOverlayBlockForPrompt[] = [],
  options: OverlayValidationOptions = {},
): OverlayValidationResult {
  const candidateBoxes = buildCandidateReferenceBoxes(hints, page);
  const candidateIds = new Set(candidateBoxes.map((candidate) => candidate.id));
  const accepted: OverlayItem[] = [];
  const reasons: Record<string, number> = {};
  let remappedCount = 0;

  for (const item of items) {
    const decision = options.regionCropMode
      ? { reason: resolveRegionCropDropReason(item), item }
      : resolveOverlayDropReason(
          item,
          accepted,
          candidateBoxes,
          candidateIds,
          options,
        );
    if (decision.reason) {
      reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
      continue;
    }
    if (decision.remapped) {
      remappedCount += 1;
    }
    accepted.push(decision.item ?? item);
  }

  const omittedCandidateIds = computeOmittedCandidateIds(
    hints,
    accepted,
    candidateIds,
  );

  return {
    items: accepted,
    droppedCount: items.length - accepted.length,
    reasons,
    remappedCount,
    omittedCandidateIds,
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

type CandidateReferenceBox = {
  id: number;
  bbox: BBox;
  label?: string;
  groupId?: string;
  containerType?: string;
};

/**
 * 영역 번역 크롭은 사용자가 직접 지정한 영역이라 페이지용 잡음 휴리스틱
 * (merged_ui_list, 짧은 텍스트, OCR 후보 겹침 등)을 적용하면 유일한 결과
 * 블록까지 버려진다. 원문이 완전히 비어 있을 때만 제외한다.
 */
function resolveRegionCropDropReason(item: OverlayItem): string | null {
  return item.jp.replace(/\s+/g, "") ? null : "empty_source";
}

type OverlayDropDecision = {
  reason: string | null;
  item?: OverlayItem;
  remapped?: boolean;
};

function resolveOverlayDropReason(
  item: OverlayItem,
  accepted: OverlayItem[],
  candidateBoxes: CandidateReferenceBox[],
  candidateIds: Set<number>,
  options: OverlayValidationOptions,
): OverlayDropDecision {
  if (isFragmentNoise(item, options.sourceLanguage)) {
    return { reason: "fragment_noise" };
  }
  if (isMergedUiListBlock(item)) {
    return { reason: "merged_ui_list" };
  }
  if (accepted.some((candidate) => candidate.id === item.id)) {
    return { reason: "duplicate_id" };
  }
  if (
    candidateIds.size > 0 &&
    !candidateIds.has(item.id) &&
    isNewIdOverlappingCandidate(item, candidateBoxes)
  ) {
    // 큰 일반 블록이 단일 후보와 강하게 겹칠 때 모델이 id를 살짝 틀린 경우,
    // 드롭 대신 해당 후보 id로 재매핑해 살린다. 작거나 다중 겹침(루비형)은 drop.
    const remappedId = resolveIdRemapForLargeBlock(item, candidateBoxes);
    if (
      remappedId !== null &&
      !accepted.some((candidate) => candidate.id === remappedId)
    ) {
      return {
        reason: null,
        item: { ...item, id: remappedId },
        remapped: true,
      };
    }
    return { reason: "new_id_overlaps_ocr_candidate" };
  }
  if (accepted.some((candidate) => isDuplicatePhysicalText(item, candidate))) {
    return { reason: "duplicate_physical_text" };
  }
  return { reason: null, item };
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

function normalizeReferenceText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
}

function isFragmentNoise(item: OverlayItem, sourceLanguage?: string): boolean {
  const source = item.jp.replace(/\s+/g, "");
  const target = item.ko.replace(/\s+/g, "");

  if (!source) {
    return true;
  }
  if (/^[.。．・…⋯･\-‐‑–—―ー~〜～_＿]+$/.test(source)) {
    return true;
  }

  const hasJapanese = /[぀-ヿ㐀-䶿一-鿿豈-﫿々ー]/.test(source);
  const usesJapaneseFragmentHeuristic = isJapaneseLanguageCode(sourceLanguage);
  if (usesJapaneseFragmentHeuristic && !hasJapanese && source.length <= 3) {
    // 큰 블록에 달린 짧은 비일본어 텍스트(간판/효과/루비 외 짧은 단어)는
    // 노이즈가 아니다. 작은 루비형 파편만 제거한다.
    if (itemArea(item) >= LARGE_ORDINARY_AREA) {
      return false;
    }
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
  // 큰 블록은 인접 수락항과 텍스트가 같아도 보존한다("큰 덩어리는 살린다").
  // 루비급 작은 파편만 중복 제거 대상으로 둔다.
  if (itemArea(item) >= SMALL_DUPLICATE_AREA) {
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

function itemArea(item: OverlayItem): number {
  return Math.max(0, item.bbox.w) * Math.max(0, item.bbox.h);
}

/**
 * 큰 일반 블록이 모델이 준 id와 다른 단일 OCR 후보와 강하게 겹칠 때,
 * 해당 후보 id로 재매핑하기 위한 후보 id를 반환. 조건이 안 맞으면 null.
 * - 항목 면적 ≥ LARGE_ORDINARY_AREA
 * - 효과음이 아닐 것(일반 텍스트)
 * - 정확히 한 개 후보와 강 containment(centerInside 양방향 또는 containment ≥ 0.8)
 */
function resolveIdRemapForLargeBlock(
  item: OverlayItem,
  candidateBoxes: CandidateReferenceBox[],
): number | null {
  if (itemArea(item) < LARGE_ORDINARY_AREA) {
    return null;
  }
  if (normalizeTextRoleForGate(item.textRole) === "sound") {
    return null;
  }
  const strongMatches: CandidateReferenceBox[] = [];
  for (const candidate of candidateBoxes) {
    if (
      centerInsideBbox(item.bbox, candidate.bbox) ||
      centerInsideBbox(candidate.bbox, item.bbox) ||
      bboxContainmentRatio(item.bbox, candidate.bbox) >=
        STRONG_OVERLAP_CONTAINMENT ||
      bboxContainmentRatio(candidate.bbox, item.bbox) >=
        STRONG_OVERLAP_CONTAINMENT
    ) {
      strongMatches.push(candidate);
    }
  }
  if (strongMatches.length !== 1) {
    return null;
  }
  return strongMatches[0].id;
}

function normalizeTextRoleForGate(value: unknown): string {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (
    ["sound", "sfx", "soundeffect", "effect", "onomatopoeia"].includes(text)
  ) {
    return "sound";
  }
  return "ordinary";
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
