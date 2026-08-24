import type { AppSettings } from "../../shared/settingsTypes";
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
  const translationWorkflowDefault =
    data.translationWorkflowDefault === "standard" ||
    data.translationWorkflowDefault === "cumulative"
      ? data.translationWorkflowDefault
      : (base.translationWorkflowDefault ?? "cumulative");
  return {
    locale: normalizeUiLocale(data.locale, base.locale),
    inpaintingGuideHidden: resolveBoolean(
      data.inpaintingGuideHidden,
      base.inpaintingGuideHidden ?? false,
    ),
    translationWorkflowDefault,
    naturalTextLayoutDefault: resolveBoolean(
      data.naturalTextLayoutDefault,
      base.naturalTextLayoutDefault ?? true,
    ),
    autoFontMatchingDefault: resolveBoolean(
      data.autoFontMatchingDefault,
      base.autoFontMatchingDefault ?? false,
    ),
    fontSizeAutoFitDefault: resolveBoolean(
      data.fontSizeAutoFitDefault,
      typeof legacyFontSizeAutoFit === "boolean"
        ? legacyFontSizeAutoFit
        : (base.fontSizeAutoFitDefault ?? true),
    ),
    eraseOriginalWorkflowDefault: completionDefaults.eraseOriginal,
    bubbleLayoutWorkflowDefault: completionDefaults.bubbleLayout,
    ...(blockModeDefault ? { blockModeDefault } : {}),
  };
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
