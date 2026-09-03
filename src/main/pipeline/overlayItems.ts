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
  BlockType,
  RenderTextDirection,
  SourceTextDirection,
  TranslationBlock,
} from "../../shared/textTypes";
import type { BlockFormatDefaults } from "../../shared/blockFormat";
import type { MangaPage } from "../../shared/libraryTypes";
import { applyNaturalTextLayout } from "../../shared/naturalTextLayout";
import {
  readTextLayoutIntent,
  readUnsuppressedTextLayoutIntent,
} from "../../shared/textLayoutIntent";
import { normalizeVisualClusterId } from "../../shared/visualClusterId";
import {
  resolveAutomaticFontDecisionV2,
  type AutomaticFontOptionsV2,
} from "./automaticFontMatchingV2";
import { applyAutomaticFontDecisionV2 } from "./automaticFontMatchingV2Apply";
import { tMain } from "./localization";
import {
  applySizeOptions,
  type OverlayFontSizeOptions,
} from "./overlayFontSize";
import type { OverlayItem } from "./types";

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_OUTLINE_COLOR = "#ffffff";
const REQUIRED_SOUND_CONFIDENCE = 1;

type NormalizedTextRole = "ordinary" | "sound" | "nontext" | "";

export type OverlayNaturalTextLayoutOptions = {
  enabled?: boolean;
  locale?: string;
};

export type OverlayAutomaticFontOptions = AutomaticFontOptionsV2;

export function overlayItemToBlock(
  item: OverlayItem,
  page: MangaPage,
  index: number,
  runId?: string,
  formatDefaults?: BlockFormatDefaults,
  naturalLayout?: OverlayNaturalTextLayoutOptions,
  automaticFont?: OverlayAutomaticFontOptions,
  fontSizeOptions?: OverlayFontSizeOptions,
): TranslationBlock {
  const type = mapOverlayType(item.type);
  const textRole = normalizeOverlayTextRole(item.textRole);
  const bbox = clampBbox(item.bbox);
  const translatedText = (item.translatedText ?? item.ko).trim();
  const sourceText = (item.sourceText ?? item.jp).trim();
  const textForSizing = translatedText || sourceText || "...";
  const fontSizePx = resolveOverlayFontSizePx(item, bbox, page, textForSizing);
  const sourceDirection =
    item.direction === "vertical" ? "vertical" : "horizontal";
  const renderDirection = resolveInitialRenderDirection(
    type,
    textRole,
    sourceDirection,
    item,
    bbox,
    page,
    fontSizePx,
  );
  const rotationDeg = resolveInitialRotationDeg(
    type,
    textRole,
    sourceDirection,
    item.angle,
  );
  const visualStyle = resolveBlockVisualStyle(type);
  const block: TranslationBlock = {
    id: buildOverlayBlockId(page.id, runId, index),
    type,
    bbox,
    bboxSpace: "normalized_1000",
    sourceText,
    translatedText,
    ...(textRole === "sound" || textRole === "ordinary" ? { textRole } : {}),
    ...buildOverlayFontIntent(item),
    confidence: normalizeConfidence(item.confidence, sourceText ? 0.92 : 0.75),
    sourceDirection,
    ...buildOverlayLayoutIntent(item.layoutIntent, textRole),
    renderDirection,
    rotationDeg,
    fontSizePx,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: DEFAULT_TEXT_COLOR,
    outlineColor: DEFAULT_OUTLINE_COLOR,
    backgroundColor: visualStyle.backgroundColor,
    opacity: visualStyle.defaultOpacity,
    autoFitText: true,
    ...(item.reviewStatus ? { reviewStatus: item.reviewStatus } : {}),
  };
  const formatted = applySizeOptions(block, formatDefaults, fontSizeOptions);
  const fontMatched = applyAutomaticFontToOverlayBlock(
    formatted,
    item,
    page,
    automaticFont,
  );
  return applyNaturalLayoutToOverlayBlock(
    fontMatched.block,
    page,
    textRole,
    formatDefaults,
    naturalLayout,
    fontMatched.fontMetricWidthScale,
  );
}

function buildOverlayLayoutIntent(
  value: unknown,
  textRole: NormalizedTextRole,
): Pick<TranslationBlock, "layoutIntent"> {
  const layoutIntent = readTextLayoutIntent(value);
  return textRole === "ordinary" &&
    (layoutIntent === "horizontal" || layoutIntent === "vertical")
    ? { layoutIntent }
    : {};
}

function buildOverlayFontIntent(
  item: OverlayItem,
): Pick<
  TranslationBlock,
  "fontRole" | "fontRoleConfidence" | "visualClusterId"
> {
  const visualClusterId = normalizeVisualClusterId(item.visualClusterId);
  return {
    ...(item.fontRole
      ? {
          fontRole: item.fontRole,
          fontRoleConfidence: normalizeConfidence(item.fontRoleConfidence, 0),
        }
      : {}),
    ...(visualClusterId ? { visualClusterId } : {}),
  };
}

function applyAutomaticFontToOverlayBlock(
  block: TranslationBlock,
  item: OverlayItem,
  page: MangaPage,
  automaticFont: OverlayAutomaticFontOptions | undefined,
): {
  block: TranslationBlock;
  fontMetricWidthScale?: number;
} {
  if (!automaticFont?.enabled) {
    return { block };
  }
  try {
    const decision = resolveAutomaticFontDecisionV2({
      block,
      item,
      page,
      options: automaticFont,
    });
    return {
      block: applyAutomaticFontDecisionV2(block, decision),
      ...(decision?.result.decision.mode === "apply" &&
      decision.fontMetricWidthScale
        ? { fontMetricWidthScale: decision.fontMetricWidthScale }
        : {}),
    };
  } catch (_error) {
    // Font matching is optional. Invalid block-local evidence must abstain for
    // this block instead of failing construction of the complete page.
    return { block };
  }
}

function applyNaturalLayoutToOverlayBlock(
  formatted: TranslationBlock,
  page: MangaPage,
  textRole: NormalizedTextRole,
  formatDefaults: BlockFormatDefaults | undefined,
  naturalLayout: OverlayNaturalTextLayoutOptions | undefined,
  fontMetricWidthScale: number | undefined,
): TranslationBlock {
  if (!naturalLayout?.enabled || textRole === "sound") {
    return formatted;
  }
  const configuredDirection = formatDefaults?.renderDirection ?? "auto";
  const directionPreference =
    configuredDirection === "auto"
      ? (readUnsuppressedTextLayoutIntent(formatted) ?? "auto")
      : configuredDirection;
  const layout = applyNaturalTextLayout(formatted, {
    enabled: true,
    pageSize: { width: page.width, height: page.height },
    locale: naturalLayout.locale,
    allowAutoVertical:
      directionPreference === "auto" &&
      (textRole === "ordinary" || textRole === ""),
    directionPreference,
    fontMetricWidthScale,
  });
  return {
    ...formatted,
    translatedText: layout.translatedText,
    renderDirection: layout.renderDirection,
  };
}

export function buildOverlayBlockId(
  pageId: string,
  runId: string | undefined,
  zeroBasedIndex: number,
): string {
  return `${pageId}-${normalizeBlockRunId(runId)}-block-${zeroBasedIndex + 1}`;
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

function resolveInitialRotationDeg(
  type: BlockType,
  textRole: NormalizedTextRole,
  sourceDirection: SourceTextDirection,
  angle: unknown,
): number {
  // Vision models can mistake a vertical Japanese column for a negative slant.
  // Discard that artifact when the translated overlay becomes horizontal, but
  // preserve real slants on horizontal text and all sound effects.
  const shouldDiscardVerticalSlant =
    sourceDirection === "vertical" && textRole !== "sound";
  return enforceRotationDeg(
    type,
    shouldDiscardVerticalSlant ? 0 : (angle ?? 0),
  );
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
