import { resolveBlockVisualStyle } from "../../shared/blockVisuals";
import {
  estimateBlockFontSizePx,
  clamp,
  clampBbox,
  enforceRenderDirection,
  enforceRotationDeg,
  normalizeBlockType,
} from "../../shared/geometry";
import type {
  BBox,
  BlockFormatDefaults,
  BlockType,
  MangaPage,
  RenderTextDirection,
  SourceTextDirection,
  TranslationBlock,
} from "../../shared/types";
import { applyFormatDefaultsToBlock } from "../../shared/blockFormat";
import { tMain } from "./localization";
import type { OverlayItem } from "./types";

export {
  getBboxNormalizationOptions,
  getOcrBboxHints,
  normalizeOverlayItemBboxes,
  validateOverlayItemsAgainstReferences,
  type OverlayValidationResult,
} from "./overlayItemReferences";
export { applyOcrCandidateGeometryLocks } from "./overlayOcrGeometryLocks";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_OUTLINE_COLOR = "#ffffff";
const REQUIRED_SOUND_CONFIDENCE = 1;

type NormalizedTextRole = "ordinary" | "sound" | "nontext" | "";

export function overlayItemToBlock(
  item: OverlayItem,
  page: MangaPage,
  index: number,
  runId?: string,
  formatDefaults?: BlockFormatDefaults,
): TranslationBlock {
  const type = mapOverlayType(item.type);
  const textRole = normalizeOverlayTextRole(item.textRole);
  const rawBbox = clampBbox(item.bbox);
  const translatedText = (item.translatedText ?? item.ko).trim();
  const sourceText = (item.sourceText ?? item.jp).trim();
  const textForSizing = translatedText || sourceText || "...";
  const lineHeight = 1.18;
  const fontSizePx = resolveOverlayFontSizePx(
    item,
    rawBbox,
    page,
    textForSizing,
  );
  const sourceDirection =
    item.direction === "vertical" ? "vertical" : "horizontal";
  const bbox = rawBbox;
  const renderDirection = resolveInitialRenderDirection(
    type,
    textRole,
    sourceDirection,
    item,
    bbox,
    page,
    fontSizePx,
  );
  const rotationDeg = enforceRotationDeg(type, item.angle ?? 0);
  const visualStyle = resolveBlockVisualStyle(type);
  const block: TranslationBlock = {
    id: `${page.id}-${normalizeBlockRunId(runId)}-block-${index + 1}`,
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
    autoFitText: true,
  };
  return applyFormatDefaultsToBlock(block, formatDefaults);
}

function normalizeBlockRunId(runId: string | undefined): string {
  const normalized = String(runId ?? "")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 48);
  return normalized || "analysis";
}

export function filterRejectedOrUncertainSoundItems(
  items: OverlayItem[],
  options: { dropUncertainSound?: boolean } = {},
): {
  items: OverlayItem[];
  droppedCount: number;
} {
  const dropUncertainSound = options.dropUncertainSound ?? true;
  const filtered: OverlayItem[] = [];
  let droppedCount = 0;

  for (const item of items) {
    const textRole = normalizeOverlayTextRole(item.textRole);
    if (textRole === "nontext") {
      droppedCount += 1;
      continue;
    }
    if (
      dropUncertainSound &&
      textRole === "sound" &&
      normalizeConfidence(item.confidence, 0) < REQUIRED_SOUND_CONFIDENCE
    ) {
      droppedCount += 1;
      continue;
    }
    filtered.push(item);
  }

  return { items: filtered, droppedCount };
}

export function buildPageWarnings(
  pageName: string,
  items: OverlayItem[],
): string[] {
  const warnings: string[] = [];
  const uncertainCount = items.filter(
    (item) => item.jp.includes("[?]") || item.ko.includes("[?]"),
  ).length;
  if (uncertainCount > 0) {
    warnings.push(
      tMain("translation.warnings.uncertainOcr", {
        page: pageName,
        count: uncertainCount,
      }),
    );
  }
  return warnings;
}

function normalizeConfidence(value: unknown, fallback: number): number {
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

function normalizeOverlayTextRole(value: unknown): NormalizedTextRole {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
  if (!text) {
    return "";
  }
  if (
    [
      "sound",
      "sfx",
      "soundeffect",
      "effect",
      "reaction",
      "onomatopoeia",
    ].includes(text)
  ) {
    return "sound";
  }
  if (
    [
      "ordinary",
      "speech",
      "dialogue",
      "dialog",
      "bubble",
      "caption",
      "narration",
      "label",
      "sign",
      "note",
      "title",
    ].includes(text)
  ) {
    return "ordinary";
  }
  if (
    [
      "nontext",
      "nottext",
      "reject",
      "decoration",
      "texture",
      "ornament",
    ].includes(text)
  ) {
    return "nontext";
  }
  return "";
}

function resolveOverlayFontSizePx(
  item: OverlayItem,
  bbox: BBox,
  page: MangaPage,
  textForSizing: string,
): number {
  if (typeof item.fontSize === "number" && Number.isFinite(item.fontSize)) {
    return Math.round(clamp(item.fontSize, 6, 160));
  }

  return estimateBlockFontSizePx(
    textForSizing,
    { bbox },
    { width: page.width, height: page.height },
  );
}

function resolveInitialRenderDirection(
  type: BlockType,
  textRole: NormalizedTextRole,
  sourceDirection: SourceTextDirection,
  item: OverlayItem,
  bbox: BBox,
  page: MangaPage,
  fontSizePx: number,
): RenderTextDirection {
  if (textRole !== "sound") {
    return enforceRenderDirection(type, "horizontal");
  }

  if (
    sourceDirection === "vertical" &&
    shouldKeepVerticalRendering(bbox, page, fontSizePx)
  ) {
    return "vertical";
  }

  return enforceRenderDirection(type, "horizontal");
}

function shouldKeepVerticalRendering(
  bbox: BBox,
  page: MangaPage,
  fontSizePx: number,
): boolean {
  const widthPx = (bbox.w / 1000) * page.width;
  const estimatedColumns = Math.max(
    1,
    Math.round(widthPx / Math.max(1, fontSizePx * 1.15)),
  );
  return estimatedColumns <= 2;
}

function mapOverlayType(value: string): BlockType {
  return normalizeBlockType(value);
}
