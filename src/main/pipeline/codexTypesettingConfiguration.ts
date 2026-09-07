import type { RegionAnalysisRequest } from "../../shared/analysisTypes";
import { isCodexDelegationEnabled } from "../../shared/codexCapabilities";
import { resolveCodexTypesettingOptions } from "../../shared/codexTypesettingDefaults";
import type { getAppPaths } from "../appPaths";
import { getAppSettings } from "../settingsStore";
import { codexTypesettingOptionsSchema } from "../../shared/codexTypesettingSchemas";
import { CODEX_TYPESETTING_MODEL } from "../../shared/codexTypesettingDefaults";
import { BUILT_IN_BLOCK_FONTS } from "../../shared/blockFontCatalog";
import { listCustomFonts } from "../customFonts";
export async function readTypesettingConfiguration(
  paths: ReturnType<typeof getAppPaths>,
  value: unknown,
  regionOnly: boolean | "sound-effects" = false,
) {
  const settings = codexTypesettingOptionsSchema.parse(value);
  const configured = await getAppSettings(paths);
  const { translation, codex } = configured;
  const regionImage =
    regionOnly === "sound-effects" ||
    (regionOnly && settings.regionOutput === "image");
  if (
    !regionImage &&
    (configured.modelProvider !== "openai-codex" ||
      codex.model !== CODEX_TYPESETTING_MODEL)
  )
    throw new Error("설정에서 Codex Astra를 선택해 주세요.");
  if (!regionImage && !codex.delegateAll)
    throw new Error("모든 작업 Codex에게 맡기기를 켜 주세요.");
  if (!translation) throw new Error("번역 언어 설정을 확인해 주세요.");
  validatePreset(settings, translation.sourceLanguage);
  return { settings, translation, codex };
}
function validatePreset(
  settings: ReturnType<typeof codexTypesettingOptionsSchema.parse>,
  sourceLanguage: string | undefined,
): void {
  const available = new Set(
    [...BUILT_IN_BLOCK_FONTS, ...listCustomFonts()].map((font) => font.id),
  );
  if (settings.preset.fonts.some((font) => !available.has(font.fontId)))
    throw new Error("등록되지 않은 프리셋 폰트가 있습니다.");
  if (sourceLanguage !== "ja")
    throw new Error("현재 Astra 경로는 일본어 원문을 대상으로 합니다.");
}

/** Snapshot delegation before cropping so execution and artwork use the same route. */
export async function resolveRegionTypesettingRequest(
  request: RegionAnalysisRequest,
  configured?: Awaited<ReturnType<typeof getAppSettings>>,
): Promise<RegionAnalysisRequest> {
  const settings = configured ?? (await getAppSettings());
  if (request.codexTypesetting || !isCodexDelegationEnabled(settings))
    return request;
  const options = resolveCodexTypesettingOptions(
    settings.ui?.codexTypesettingPreferences,
    settings.translation?.targetLanguage ?? "ko",
  );
  const eraseOriginal = request.eraseOriginal ?? options.eraseOriginal;
  return {
    ...request,
    eraseOriginal,
    codexTypesetting: { ...options, eraseOriginal },
  };
}

export function configuredTypesettingOptions(
  settings: Awaited<ReturnType<typeof getAppSettings>>,
) {
  return isCodexDelegationEnabled(settings)
    ? resolveCodexTypesettingOptions(
        settings.ui?.codexTypesettingPreferences,
        settings.translation?.targetLanguage ?? "ko",
      )
    : undefined;
}
