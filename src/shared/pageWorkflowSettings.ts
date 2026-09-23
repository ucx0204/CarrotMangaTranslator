import type { UiSettings } from "./settingsTypes";
import {
  PageWorkflowPlanSchema,
  PageWorkflowPresetSchema,
  PageWorkflowFavoritePresetIdsSchema,
  createPageWorkflowPlan,
} from "./pageWorkflowTypes";
import { type PageWorkflowStage } from "./pageWorkflowStages";

export function initialPageWorkflowPlan(ui: UiSettings = {}) {
  if (ui.pageWorkflowDefault) return ui.pageWorkflowDefault;
  const stages: PageWorkflowStage[] = ["ocr", "translate"];
  if (ui.blockModeDefault !== "keep") stages.unshift("detect");
  if (ui.autoFontMatchingDefault || ui.aiFontSizeMatchingDefault !== false)
    stages.push("typography");
  if (ui.eraseOriginalWorkflowDefault ?? true) stages.push("erase");
  if (ui.bubbleLayoutWorkflowDefault || ui.naturalTextLayoutDefault)
    stages.push("layout");
  stages.push("review");
  return { ...createPageWorkflowPlan(stages), ...migrateWorkflowOptions(ui) };
}

function migrateWorkflowOptions(ui: UiSettings) {
  return {
    cumulative: ui.translationWorkflowDefault !== "standard",
    cumulativeDetail: ui.cumulativeContextDetailDefault ?? "detailed",
    autoFont: ui.autoFontMatchingDefault ?? false,
    autoSize: ui.aiFontSizeMatchingDefault ?? true,
    bubbleLayout: ui.bubbleLayoutWorkflowDefault ?? false,
    naturalLayout: ui.naturalTextLayoutDefault ?? false,
    erasureEngine: ui.codexErasureDefault
      ? ("codex" as const)
      : ("local" as const),
  };
}

export function normalizePageWorkflowUi(
  data: Record<string, unknown>,
): Pick<
  UiSettings,
  | "hayaiTranslationUi"
  | "pageWorkflowDefault"
  | "pageWorkflowPresets"
  | "pageWorkflowFavoritePresetIds"
  | "blockReadingSize"
> {
  const plan = PageWorkflowPlanSchema.safeParse(data.pageWorkflowDefault);
  const presets = PageWorkflowPresetSchema.array()
    .max(50)
    .safeParse(data.pageWorkflowPresets);
  const favorites = PageWorkflowFavoritePresetIdsSchema.safeParse(
    data.pageWorkflowFavoritePresetIds,
  );
  return {
    hayaiTranslationUi:
      data.hayaiTranslationUi === "classic" ? "classic" : "workflow",
    ...(plan.success ? { pageWorkflowDefault: plan.data } : {}),
    ...(presets.success ? { pageWorkflowPresets: presets.data } : {}),
    ...(favorites.success
      ? { pageWorkflowFavoritePresetIds: [...new Set(favorites.data)] }
      : {}),
    blockReadingSize:
      typeof data.blockReadingSize === "number" &&
      Number.isInteger(data.blockReadingSize)
        ? Math.min(24, Math.max(12, data.blockReadingSize))
        : 15,
  };
}
