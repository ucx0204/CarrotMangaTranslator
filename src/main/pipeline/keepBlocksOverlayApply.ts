import type { MangaPage } from "../../shared/libraryTypes";
import { applyNaturalTextLayout } from "../../shared/naturalTextLayout";
import {
  applyModelTextLayoutIntent,
  MIN_EXTERIOR_VERTICAL_NARRATION_CONFIDENCE,
} from "../../shared/textLayoutIntent";
import type { TranslationBlock } from "../../shared/textTypes";
import { resolveAutomaticFontDecisionV2 } from "./automaticFontMatchingV2";
import { applyAutomaticFontDecisionV2 } from "./automaticFontMatchingV2Apply";
import type { KeepBlocksAutomaticFontOptions } from "./keepBlocksAutomaticFont";
import { applySizeOptions } from "./overlayFontSize";
import type { SourceFontSizeEstimate } from "./sourceFontSizeGeometry";
import type { OverlayItem } from "./types";

export function applyOverlayItemToExistingBlock({
  automaticFont,
  block,
  item,
  naturalLayout,
  page,
  sourceFontSize,
  effectiveTextRole,
  skipNaturalLayout,
}: {
  automaticFont?: KeepBlocksAutomaticFontOptions;
  block: TranslationBlock;
  item: OverlayItem;
  naturalLayout?: { enabled?: boolean; locale?: string };
  page: MangaPage;
  sourceFontSize?: SourceFontSizeEstimate;
  effectiveTextRole?: TranslationBlock["textRole"];
  skipNaturalLayout: boolean;
}): TranslationBlock {
  const textUpdated = applyModelTextLayoutIntent(
    {
      ...block,
      sourceText: item.jp.trim(),
      translatedText: item.ko.trim(),
      ...(effectiveTextRole ? { textRole: effectiveTextRole } : {}),
      ...(item.fontRole
        ? {
            fontRole: item.fontRole,
            fontRoleConfidence: normalizeItemConfidence(
              item.fontRoleConfidence,
              0,
            ),
          }
        : {}),
      ...(item.visualClusterId
        ? { visualClusterId: item.visualClusterId }
        : {}),
      confidence: normalizeItemConfidence(item.confidence, block.confidence),
    },
    resolveCurrentItemLayoutIntent(item),
    effectiveTextRole,
  );
  const sourceSized = applyKeepBlocksSourceFontSize(
    textUpdated,
    sourceFontSize,
  );
  const itemWithPersistedIntent =
    item.fontRole || !block.fontRole
      ? item
      : {
          ...item,
          fontRole: block.fontRole,
          fontRoleConfidence: block.fontRoleConfidence,
        };
  const fontDecision = resolveKeepBlocksFontDecision({
    automaticFont,
    block: sourceSized,
    item: effectiveTextRole
      ? { ...itemWithPersistedIntent, textRole: effectiveTextRole }
      : itemWithPersistedIntent,
    page,
  });
  const updated = applyAutomaticFontDecisionV2(sourceSized, fontDecision);
  if (!naturalLayout?.enabled || skipNaturalLayout) return updated;
  const layout = applyNaturalTextLayout(updated, {
    enabled: true,
    pageSize: { width: page.width, height: page.height },
    locale: naturalLayout.locale,
    allowAutoVertical: false,
    directionPreference: updated.renderDirection,
    fontMetricWidthScale:
      fontDecision?.result.decision.mode === "apply"
        ? fontDecision.fontMetricWidthScale
        : undefined,
  });
  return { ...updated, translatedText: layout.translatedText };
}

function applyKeepBlocksSourceFontSize(
  block: TranslationBlock,
  sourceFontSize: SourceFontSizeEstimate | undefined,
): TranslationBlock {
  if (!sourceFontSize) return block;
  return applySizeOptions(block, undefined, {
    fontSizeAutoFit: true,
    sourceFontSize,
  });
}

function resolveKeepBlocksFontDecision({
  automaticFont,
  block,
  item,
  page,
}: {
  automaticFont?: KeepBlocksAutomaticFontOptions;
  block: TranslationBlock;
  item: OverlayItem;
  page: MangaPage;
}) {
  return automaticFont?.enabled
    ? resolveAutomaticFontDecisionV2({
        block,
        item,
        page,
        options: {
          ...automaticFont,
          pageCoordinator: automaticFont.pageCoordinator,
          runtimeArtifactStatus:
            automaticFont.pageInference?.runtimeArtifactStatus,
          pixelInference:
            automaticFont.pageInference?.pixelInferenceByBlockId.get(block.id),
        },
      })
    : undefined;
}

/**
 * Keep-mode blocks can carry a persisted narration role from an older run.
 * Never let that stale value authenticate a new vertical advisory: the role
 * and confidence must both be present on the current translated item.
 */
function resolveCurrentItemLayoutIntent(
  item: OverlayItem,
): OverlayItem["layoutIntent"] {
  if (item.layoutIntent !== "vertical") return item.layoutIntent;
  return item.fontRole === "narration" &&
    typeof item.fontRoleConfidence === "number" &&
    Number.isFinite(item.fontRoleConfidence) &&
    item.fontRoleConfidence >= MIN_EXTERIOR_VERTICAL_NARRATION_CONFIDENCE
    ? "vertical"
    : "auto";
}

function normalizeItemConfidence(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, normalized));
}
