import { resolveBlockVisualStyle } from "../../shared/blockVisuals";
import { estimateBlockFontSizePx, clamp, clampBbox, enforceRenderDirection, enforceRotationDeg, normalizeBlockType, pixelsToBbox } from "../../shared/geometry";
import type { BBox, BlockType, MangaPage, RenderTextDirection, SourceTextDirection, TranslationBlock } from "../../shared/types";
import type { BboxNormalizationOptions, DetectedBboxSpace, OverlayItem, RequestSummary, TranslationResult } from "./types";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_OUTLINE_COLOR = "#ffffff";
const REQUIRED_SOUND_CONFIDENCE = 1;

type NormalizedTextRole = "ordinary" | "sound" | "nontext" | "";

export function overlayItemToBlock(item: OverlayItem, page: MangaPage, index: number): TranslationBlock {
  const type = mapOverlayType(item.type);
  const textRole = normalizeOverlayTextRole(item.textRole);
  const rawBbox = clampBbox(item.bbox);
  const translatedText = item.ko.trim();
  const sourceText = item.jp.trim();
  const textForSizing = translatedText || sourceText || "...";
  const lineHeight = 1.18;
  const fontSizePx = resolveOverlayFontSizePx(item, rawBbox, page, textForSizing);
  const sourceDirection = item.direction === "vertical" ? "vertical" : "horizontal";
  const bbox = rawBbox;
  const renderDirection = resolveInitialRenderDirection(type, textRole, sourceDirection, item, bbox, page, fontSizePx);
  const rotationDeg = enforceRotationDeg(type, item.angle ?? 0);
  const visualStyle = resolveBlockVisualStyle(type);
  return {
    id: `${page.id}-block-${index + 1}`,
    type,
    bbox,
    bboxSpace: "normalized_1000",
    sourceText,
    translatedText,
    confidence: normalizeConfidence(item.confidence, sourceText ? 0.92 : 0.75),
    sourceDirection,
    renderDirection,
    rotationDeg,
    fontSizePx,
    lineHeight,
    textAlign: "center",
    textColor: DEFAULT_TEXT_COLOR,
    outlineColor: DEFAULT_OUTLINE_COLOR,
    backgroundColor: visualStyle.backgroundColor,
    opacity: visualStyle.defaultOpacity,
    autoFitText: true
  };
}

export function filterRejectedOrUncertainSoundItems(items: OverlayItem[]): { items: OverlayItem[]; droppedCount: number } {
  const filtered: OverlayItem[] = [];
  let droppedCount = 0;

  for (const item of items) {
    const textRole = normalizeOverlayTextRole(item.textRole);
    if (textRole === "nontext") {
      droppedCount += 1;
      continue;
    }
    if (textRole === "sound" && normalizeConfidence(item.confidence, 0) < REQUIRED_SOUND_CONFIDENCE) {
      droppedCount += 1;
      continue;
    }
    filtered.push(item);
  }

  return { items: filtered, droppedCount };
}

export function normalizeOverlayItemBboxes(items: OverlayItem[], page: MangaPage, options: BboxNormalizationOptions = {}): OverlayItem[] {
  const bboxSpace = options.coordinateSpace ?? inferDetectedBboxSpace(items, page);
  const pixelWidth = options.pixelWidth && options.pixelWidth > 0 ? options.pixelWidth : page.width;
  const pixelHeight = options.pixelHeight && options.pixelHeight > 0 ? options.pixelHeight : page.height;
  const fontSizeScale = bboxSpace === "pixels" ? Math.max(page.width / pixelWidth, page.height / pixelHeight) : 1;
  return items.map((item) => ({
    ...item,
    bbox: bboxSpace === "pixels" ? pixelsToBbox(item.bbox, pixelWidth, pixelHeight) : clampBbox(item.bbox),
    fontSize:
      bboxSpace === "pixels" && typeof item.fontSize === "number" && Number.isFinite(item.fontSize)
        ? Math.max(1, Math.round(item.fontSize * fontSizeScale))
        : item.fontSize
  }));
}

export function getBboxNormalizationOptions(requestBody: TranslationResult["requestBody"]): BboxNormalizationOptions {
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
    pixelHeight: Number(summary.bboxCoordinateFrame?.height)
  };
}

export function getOcrBboxHints(requestBody: TranslationResult["requestBody"]): NonNullable<RequestSummary["ocrBboxHints"]> {
  if (!requestBody || typeof requestBody !== "object") {
    return [];
  }
  const hints = (requestBody as RequestSummary).ocrBboxHints;
  return Array.isArray(hints) ? hints : [];
}

export function applyOcrCandidateGeometryLocks(items: OverlayItem[], page: MangaPage, hints: NonNullable<RequestSummary["ocrBboxHints"]>): OverlayItem[] {
  if (hints.length === 0) {
    return items;
  }

  const hintMap = new Map<number, { bbox: BBox; label: string }>();
  for (const hint of hints) {
    const id = Number(hint.id);
    const x1 = Number(hint.x1);
    const y1 = Number(hint.y1);
    const x2 = Number(hint.x2);
    const y2 = Number(hint.y2);
    if (!Number.isInteger(id) || id <= 0 || ![x1, y1, x2, y2].every(Number.isFinite)) {
      continue;
    }
    hintMap.set(id, {
      bbox: pixelsToBbox({
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1)
      }, page.width, page.height),
      label: String(hint.label ?? "")
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
    return {
      ...item,
      bbox: lockedHint.bbox
    };
  });
}

export function buildPageWarnings(pageName: string, items: OverlayItem[]): string[] {
  const warnings: string[] = [];
  const uncertainCount = items.filter((item) => item.jp.includes("[?]") || item.ko.includes("[?]")).length;
  if (uncertainCount > 0) {
    warnings.push(`${pageName}: 불확실한 OCR 조각이 ${uncertainCount}개 있습니다.`);
  }
  return warnings;
}

export function normalizeConfidence(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return clamp(normalized, 0, 1);
}

export function hasUncertaintyMarker(value: string | undefined): boolean {
  return String(value ?? "").includes("[?]");
}

export function containsJapaneseKana(value: string | undefined): boolean {
  return /[\u3040-\u30ff]/u.test(String(value ?? ""));
}

export function normalizeOverlayTextRole(value: unknown): NormalizedTextRole {
  const text = String(value ?? "").trim().toLowerCase().replace(/[_\s-]+/g, "");
  if (!text) {
    return "";
  }
  if (["sound", "sfx", "soundeffect", "effect", "reaction", "onomatopoeia"].includes(text)) {
    return "sound";
  }
  if (["ordinary", "speech", "dialogue", "dialog", "bubble", "caption", "narration", "label", "sign", "note", "title"].includes(text)) {
    return "ordinary";
  }
  if (["nontext", "nottext", "reject", "decoration", "texture", "ornament"].includes(text)) {
    return "nontext";
  }
  return "";
}

function resolveOverlayFontSizePx(item: OverlayItem, bbox: BBox, page: MangaPage, textForSizing: string): number {
  if (typeof item.fontSize === "number" && Number.isFinite(item.fontSize)) {
    return Math.round(clamp(item.fontSize, 6, 160));
  }

  return estimateBlockFontSizePx(textForSizing, { bbox }, { width: page.width, height: page.height });
}

function resolveInitialRenderDirection(
  type: BlockType,
  textRole: NormalizedTextRole,
  sourceDirection: SourceTextDirection,
  item: OverlayItem,
  bbox: BBox,
  page: MangaPage,
  fontSizePx: number
): RenderTextDirection {
  const rotationDeg = enforceRotationDeg(type, item.angle ?? 0);
  if (textRole !== "sound") {
    if (Math.abs(rotationDeg) > 0) {
      return "rotated";
    }
    return enforceRenderDirection(type, "horizontal");
  }

  if (sourceDirection === "vertical" && shouldKeepVerticalRendering(bbox, page, fontSizePx)) {
    return "vertical";
  }

  if (Math.abs(rotationDeg) > 0) {
    return "rotated";
  }

  return enforceRenderDirection(type, "horizontal");
}

function shouldKeepVerticalRendering(bbox: BBox, page: MangaPage, fontSizePx: number): boolean {
  const widthPx = (bbox.w / 1000) * page.width;
  const estimatedColumns = Math.max(1, Math.round(widthPx / Math.max(1, fontSizePx * 1.15)));
  return estimatedColumns <= 2;
}

function isNearOcrHint(modelBbox: BBox, hintBbox: BBox, page: MangaPage): boolean {
  const modelPx = normalizedBboxToPixels(modelBbox, page);
  const hintPx = normalizedBboxToPixels(hintBbox, page);
  const modelCenterX = modelPx.x + modelPx.w / 2;
  const modelCenterY = modelPx.y + modelPx.h / 2;
  const hintCenterX = hintPx.x + hintPx.w / 2;
  const hintCenterY = hintPx.y + hintPx.h / 2;
  const distance = Math.hypot(modelCenterX - hintCenterX, modelCenterY - hintCenterY);
  const tolerance = Math.max(150, Math.max(hintPx.w, hintPx.h) * 1.35);
  return distance <= tolerance || bboxOverlapRatio(modelPx, hintPx) > 0.1;
}

function normalizedBboxToPixels(bbox: BBox, page: MangaPage): BBox {
  return {
    x: (bbox.x / 1000) * page.width,
    y: (bbox.y / 1000) * page.height,
    w: (bbox.w / 1000) * page.width,
    h: (bbox.h / 1000) * page.height
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

function inferDetectedBboxSpace(items: OverlayItem[], page: Pick<MangaPage, "width" | "height">): DetectedBboxSpace {
  const coordinatePixelEvidence = items.filter((item) => hasPixelCoordinateEvidence(item.bbox, page)).length;
  if (coordinatePixelEvidence > 0) {
    return "pixels";
  }

  const overflowPixelEvidence = items.filter((item) => hasPixelOverflowEvidence(item.bbox, page)).length;
  return overflowPixelEvidence >= Math.max(2, Math.ceil(items.length * 0.2)) ? "pixels" : "normalized_1000";
}

function hasPixelCoordinateEvidence(bbox: BBox, page: Pick<MangaPage, "width" | "height">): boolean {
  return fitsPagePixels(bbox, page) && (bbox.x > 1000 || bbox.y > 1000 || bbox.w > 1000 || bbox.h > 1000);
}

function hasPixelOverflowEvidence(bbox: BBox, page: Pick<MangaPage, "width" | "height">): boolean {
  const right = bbox.x + bbox.w;
  const bottom = bbox.y + bbox.h;
  const normalizedTolerance = 80;
  return fitsPagePixels(bbox, page) && (right > 1000 + normalizedTolerance || bottom > 1000 + normalizedTolerance);
}

function fitsPagePixels(bbox: BBox, page: Pick<MangaPage, "width" | "height">): boolean {
  const right = bbox.x + bbox.w;
  const bottom = bbox.y + bbox.h;
  const pixelBoundsTolerance = 1.06;
  return (
    bbox.x >= 0 &&
    bbox.y >= 0 &&
    bbox.w > 0 &&
    bbox.h > 0 &&
    right <= page.width * pixelBoundsTolerance &&
    bottom <= page.height * pixelBoundsTolerance
  );
}

function mapOverlayType(value: string): BlockType {
  return normalizeBlockType(value);
}
