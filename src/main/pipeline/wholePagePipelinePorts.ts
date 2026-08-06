import { join } from "node:path";
import type { AppSettings } from "../../shared/settingsTypes";
import { getAppPaths, type AppPaths } from "../appPaths";
import {
  readWorkTypographyProfile,
  saveChapterStoryMemory,
  saveWorkStyleGuide,
} from "../library";
import { logError, logInfo, logWarn } from "../logger";
import { getAppSettings } from "../settingsStore";
import { loadTranslationRuntimePort } from "../translationRuntime";
import type { PageContextPersistenceRepository } from "./pageContextPersistence";
import type { PipelineDiagnostics } from "./translationAttemptLogging";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { WorkTypographyProfileV2 } from "../../shared/fontMatchingProfileTypes";
import { resolveUiLocale, type UiLocale } from "../../shared/uiLocales";
import {
  loadBuiltInFontMatchingCandidates,
  resolveBuiltInFontMatchingAssetRoots,
} from "../builtInFontMatchingCatalog";
import { loadAutoMatchActiveCandidateSelection } from "./autoMatchActiveCatalog";
import type { AutoMatchActiveCandidateSelection } from "./autoMatchActiveCatalogTypes";
import { FONT_MATCHING_ACTIVE_CATALOG_FILE } from "./fontMatchingRuntimeArtifactContract";
import { resolveFontMatchingArtifactDirSync } from "./fontMatchingRuntimePaths";
import { createWorkerFontMatchingPageInferencePort } from "./fontMatchingInferenceWorkerClient";
import type { FontMatchingPageInferencePort } from "./fontMatchingPagePixelInferenceTypes";

type PipelineSettingsRepository = {
  getAppSettings: (paths: AppPaths) => Promise<AppSettings>;
};

export type WholePagePipelineDependencies = {
  paths: AppPaths;
  settings: PipelineSettingsRepository;
  fontMatching: {
    loadCandidates: (
      targetLanguage?: string,
    ) => readonly AutomaticFontCandidate[];
    loadProfile?: (workId: string) => Promise<WorkTypographyProfileV2 | null>;
    pageInference?: FontMatchingPageInferencePort;
  };
  pageContext: PageContextPersistenceRepository;
  diagnostics: PipelineDiagnostics;
  runtime: TranslationRuntimePort;
};

export type FontMatchingProfileLoadResult =
  | { status: "loaded"; profile: WorkTypographyProfileV2 }
  | { status: "absent"; profile: null }
  | { status: "error"; profile: null };

export type FontMatchingOutputDependencies = Pick<
  WholePagePipelineDependencies,
  "fontMatching" | "diagnostics"
>;

export function createDefaultWholePagePipelineDependencies(): WholePagePipelineDependencies {
  const paths = getAppPaths();
  const selectionByLocale = new Map<
    string,
    AutoMatchActiveCandidateSelection
  >();
  const loadSelection = (
    locale: UiLocale,
  ): AutoMatchActiveCandidateSelection => {
    if (locale !== "ko") {
      throw new Error(
        "The sealed font matching runtime catalog is Korean-only.",
      );
    }
    const cached = selectionByLocale.get(locale);
    if (cached) return cached;
    const builtInCandidates = loadBuiltInFontMatchingCandidates(
      locale,
      logWarn,
    );
    const selection = loadAutoMatchActiveCandidateSelection({
      activeCatalogPath: join(
        resolveFontMatchingArtifactDirSync(paths),
        FONT_MATCHING_ACTIVE_CATALOG_FILE,
      ),
      assetRoots: resolveBuiltInFontMatchingAssetRoots(),
      builtInCandidates,
      targetLocale: locale,
    });
    selectionByLocale.set(locale, selection);
    return selection;
  };
  return {
    paths,
    settings: { getAppSettings },
    fontMatching: {
      loadCandidates: (targetLanguage) => {
        const locale = resolveUiLocale(targetLanguage);
        if (!locale) return [];
        if (locale !== "ko") return [];
        return loadSelection(locale).candidates;
      },
      loadProfile: readWorkTypographyProfile,
      pageInference: createWorkerFontMatchingPageInferencePort({
        paths,
        loadSelection,
        reportWarning: logWarn,
      }),
    },
    pageContext: { saveChapterStoryMemory, saveWorkStyleGuide },
    diagnostics: {
      info: logInfo,
      warn: logWarn,
      error: logError,
    },
    runtime: loadTranslationRuntimePort(),
  };
}

export async function safelyLoadFontMatchingProfile(
  dependencies: FontMatchingOutputDependencies,
  workId?: string,
): Promise<FontMatchingProfileLoadResult> {
  if (!workId || !dependencies.fontMatching.loadProfile) {
    return { status: "absent", profile: null };
  }
  try {
    const profile = await dependencies.fontMatching.loadProfile(workId);
    return profile
      ? { status: "loaded", profile }
      : { status: "absent", profile: null };
  } catch (error) {
    dependencies.diagnostics.warn(
      "Font Matching V2 work profile could not be loaded",
      error,
    );
    return { status: "error", profile: null };
  }
}

export function safelyLoadFontMatchingCandidates(
  dependencies: FontMatchingOutputDependencies,
  targetLanguage?: string,
): readonly AutomaticFontCandidate[] {
  try {
    return dependencies.fontMatching.loadCandidates(targetLanguage);
  } catch (error) {
    dependencies.diagnostics.warn(
      "Automatic font matching catalog could not be loaded",
      error,
    );
    return [];
  }
}
