import {
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_K,
  DEFAULT_API_TOP_P,
} from "../../shared/modelPresets";
import type {
  ApiReasoningEffort,
  AppSettings,
} from "../../shared/settingsTypes";
import type { TranslationOptions } from "./appSettingsTypes";
import {
  isOfficialOpenAiApiBaseUrl,
  resolveNullableIntegerRange,
  resolveNullableNumberRange,
  resolveNullableReasoningEffort,
  resolveOpenAiCompatibleBaseUrl,
  resolveOptionalJsonObjectString,
  resolveOptionalString,
} from "./appSettingsResolvers";

type ApiTranslationOptions = Pick<
  TranslationOptions,
  | "apiBaseUrl"
  | "apiModel"
  | "apiKey"
  | "apiTemperature"
  | "apiTopP"
  | "apiTopK"
  | "apiReasoningEffort"
  | "apiExtraBodyJson"
  | "apiCustomHeadersJson"
>;

export function resolveApiTranslationOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
): ApiTranslationOptions {
  const apiBaseUrl = resolveOpenAiCompatibleBaseUrl(
    runtimeEnv.MANGA_TRANSLATOR_API_BASE_URL,
    settings.api.baseUrl,
  );
  const apiKey = resolveApiKey(runtimeEnv, settings, apiBaseUrl);
  return {
    apiBaseUrl,
    apiModel:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_API_MODEL) ??
      settings.api.model,
    ...(apiKey ? { apiKey } : {}),
    apiTemperature: resolveApiNullableNumber({
      envValue: runtimeEnv.MANGA_TRANSLATOR_API_TEMPERATURE,
      settingsValue: settings.api.temperature,
      fallback: DEFAULT_API_TEMPERATURE,
      min: 0,
      max: 2,
    }),
    apiTopP: resolveApiNullableNumber({
      envValue: runtimeEnv.MANGA_TRANSLATOR_API_TOP_P,
      settingsValue: settings.api.topP,
      fallback: DEFAULT_API_TOP_P,
      min: 0,
      max: 1,
    }),
    apiTopK: resolveApiNullableInteger({
      envValue: runtimeEnv.MANGA_TRANSLATOR_API_TOP_K,
      settingsValue: settings.api.topK,
      fallback: DEFAULT_API_TOP_K,
      min: 1,
      max: 1000,
    }),
    apiReasoningEffort: resolveApiReasoningEffort({
      envValue: runtimeEnv.MANGA_TRANSLATOR_API_REASONING_EFFORT,
      settingsValue: settings.api.reasoningEffort,
      fallback: DEFAULT_API_REASONING_EFFORT,
    }),
    apiExtraBodyJson: resolveOptionalJsonObjectString(
      runtimeEnv.MANGA_TRANSLATOR_API_EXTRA_BODY,
      settings.api.extraBodyJson ?? DEFAULT_API_EXTRA_BODY_JSON,
    ),
    apiCustomHeadersJson: resolveOptionalJsonObjectString(
      runtimeEnv.MANGA_TRANSLATOR_API_HEADERS,
      settings.api.customHeadersJson ?? DEFAULT_API_CUSTOM_HEADERS_JSON,
    ),
  };
}

function resolveApiKey(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
  apiBaseUrl: string,
): string | undefined {
  return (
    resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_API_KEY) ??
    resolveOptionalString(settings.api.apiKey) ??
    (isOfficialOpenAiApiBaseUrl(apiBaseUrl)
      ? resolveOptionalString(runtimeEnv.OPENAI_API_KEY)
      : undefined)
  );
}

function resolveApiNullableNumber({
  envValue,
  settingsValue,
  fallback,
  min,
  max,
}: {
  envValue: unknown;
  settingsValue: number | null | undefined;
  fallback: number | null;
  min: number;
  max: number;
}): number | null {
  if (envValue !== undefined) {
    return resolveNullableNumberRange(envValue, fallback, min, max);
  }
  return resolveNullableNumberRange(settingsValue, fallback, min, max);
}

function resolveApiNullableInteger({
  envValue,
  settingsValue,
  fallback,
  min,
  max,
}: {
  envValue: unknown;
  settingsValue: number | null | undefined;
  fallback: number | null;
  min: number;
  max: number;
}): number | null {
  if (envValue !== undefined) {
    return resolveNullableIntegerRange(envValue, fallback, min, max);
  }
  return resolveNullableIntegerRange(settingsValue, fallback, min, max);
}

function resolveApiReasoningEffort({
  envValue,
  settingsValue,
  fallback,
}: {
  envValue: unknown;
  settingsValue: ApiReasoningEffort | null | undefined;
  fallback: ApiReasoningEffort | null;
}): ApiReasoningEffort | null {
  if (envValue !== undefined) {
    return resolveNullableReasoningEffort(envValue, fallback);
  }
  return resolveNullableReasoningEffort(settingsValue, fallback);
}
