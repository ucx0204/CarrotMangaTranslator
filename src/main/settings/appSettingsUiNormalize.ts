import type {
  AppSettings,
  WheelZoomSensitivityPercent,
} from "../../shared/settingsTypes";
import { normalizeUiLocale } from "../../shared/uiLocales";
import { resolveBoolean } from "./appSettingsResolvers";

export function normalizeUiSettings(
  ui: Record<string, unknown> | null,
  defaults: AppSettings,
  legacyFontSizeAutoFit?: unknown,
): NonNullable<AppSettings["ui"]> {
  const data = ui ?? {};
  const base = defaults.ui ?? {};
  const blockModeDefault = resolveBlockModeDefault(
    data.blockModeDefault,
    base.blockModeDefault,
  );
  const completionDefaults = resolveTranslationCompletionDefaults(data, base);
  const translationWorkflowDefault = resolveTranslationWorkflowDefault(
    data.translationWorkflowDefault,
    base.translationWorkflowDefault,
  );
  const cumulativeContextDetailDefault = resolveCumulativeContextDetailDefault(
    data.cumulativeContextDetailDefault,
    base.cumulativeContextDetailDefault,
  );
  return {
    locale: normalizeUiLocale(data.locale, base.locale),
    inpaintingGuideHidden: resolveBoolean(
      data.inpaintingGuideHidden,
      base.inpaintingGuideHidden ?? false,
    ),
    translationWorkflowDefault,
    cumulativeContextDetailDefault,
    naturalTextLayoutDefault: resolveBoolean(
      data.naturalTextLayoutDefault,
      base.naturalTextLayoutDefault ?? false,
    ),
    autoFontMatchingDefault: resolveBoolean(
      data.autoFontMatchingDefault,
      base.autoFontMatchingDefault ?? false,
    ),
    aiFontSizeMatchingDefault: resolveBoolean(
      data.aiFontSizeMatchingDefault,
      resolveFontSizeAutoFitFallback(
        data.fontSizeAutoFitDefault ?? legacyFontSizeAutoFit,
        base.aiFontSizeMatchingDefault ?? base.fontSizeAutoFitDefault,
      ),
    ),
    sfxAutoFontMatchingDefault: resolveBoolean(
      data.sfxAutoFontMatchingDefault,
      base.sfxAutoFontMatchingDefault ?? false,
    ),
    sfxInpaintAfterTranslationDefault: resolveBoolean(
      data.sfxInpaintAfterTranslationDefault,
      base.sfxInpaintAfterTranslationDefault ?? false,
    ),
    ...(typeof data.fontSizeAutoFitDefault === "boolean"
      ? {
          fontSizeAutoFitDefault: resolveBoolean(
            data.fontSizeAutoFitDefault,
            resolveFontSizeAutoFitFallback(
              legacyFontSizeAutoFit,
              base.fontSizeAutoFitDefault,
            ),
          ),
        }
      : {}),
    eraseOriginalWorkflowDefault: completionDefaults.eraseOriginal,
    bubbleLayoutWorkflowDefault: completionDefaults.bubbleLayout,
    wheelZoomSensitivityPercent: resolveWheelZoomSensitivityPercent(
      data.wheelZoomSensitivityPercent,
      base.wheelZoomSensitivityPercent,
    ),
    ...(blockModeDefault ? { blockModeDefault } : {}),
  };
}

function resolveWheelZoomSensitivityPercent(
  value: unknown,
  fallback: WheelZoomSensitivityPercent | undefined,
): WheelZoomSensitivityPercent {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
    ? (value as WheelZoomSensitivityPercent)
    : (fallback ?? 1);
}

function resolveTranslationWorkflowDefault(
  value: unknown,
  fallback: "standard" | "cumulative" | undefined,
): "standard" | "cumulative" {
  return value === "standard" || value === "cumulative"
    ? value
    : (fallback ?? "cumulative");
}

function resolveCumulativeContextDetailDefault(
  value: unknown,
  fallback: "detailed" | "balanced" | "essential" | undefined,
): "detailed" | "balanced" | "essential" {
  return value === "detailed" || value === "balanced" || value === "essential"
    ? value
    : (fallback ?? "detailed");
}

function resolveFontSizeAutoFitFallback(
  legacyValue: unknown,
  fallback: boolean | undefined,
): boolean {
  return typeof legacyValue === "boolean" ? legacyValue : (fallback ?? true);
}

function resolveTranslationCompletionDefaults(
  data: Record<string, unknown>,
  base: NonNullable<AppSettings["ui"]>,
): { eraseOriginal: boolean; bubbleLayout: boolean } {
  if (typeof data.eraseOriginalWorkflowDefault !== "boolean") {
    return {
      eraseOriginal:
        typeof data.bubbleLayoutWorkflowDefault === "boolean"
          ? data.bubbleLayoutWorkflowDefault
          : (base.eraseOriginalWorkflowDefault ?? false),
      bubbleLayout: true,
    };
  }
  return {
    eraseOriginal: data.eraseOriginalWorkflowDefault,
    bubbleLayout: resolveBoolean(
      data.bubbleLayoutWorkflowDefault,
      base.bubbleLayoutWorkflowDefault ?? true,
    ),
  };
}

function resolveBlockModeDefault(
  value: unknown,
  fallback: "auto" | "keep" | undefined,
): "auto" | "keep" | undefined {
  return value === "auto" || value === "keep" ? value : fallback;
}
