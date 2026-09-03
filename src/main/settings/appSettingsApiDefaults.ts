import {
  DEFAULT_API_BASE_URL,
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_MODEL,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_K,
  DEFAULT_API_TOP_P,
} from "../../shared/modelPresets";
import {
  DEFAULT_API_KEY_MAX_ATTEMPTS,
  DEFAULT_API_RETRY_DELAY_SECONDS,
  MAX_API_KEY_MAX_ATTEMPTS,
  MAX_API_RETRY_DELAY_SECONDS,
  MIN_API_KEY_MAX_ATTEMPTS,
  MIN_API_RETRY_DELAY_SECONDS,
} from "../../shared/apiKeySettings";
import { inferApiProviderPreset } from "../../shared/apiProviderPresets";
import type { ResolvedApiSettings } from "../../shared/settingsTypes";
import {
  resolveNullableIntegerRange,
  resolveNullableNumberRange,
  resolveNullableReasoningEffort,
  resolveNonEmptyString,
  resolveNumberRange,
  resolveOpenAiCompatibleBaseUrl,
} from "./appSettingsResolvers";

export function resolveDefaultApiSettings(
  env: NodeJS.ProcessEnv,
): ResolvedApiSettings {
  const profile = {
    baseUrl: resolveOpenAiCompatibleBaseUrl(
      env.MANGA_TRANSLATOR_API_BASE_URL,
      DEFAULT_API_BASE_URL,
    ),
    model: resolveNonEmptyString(
      env.MANGA_TRANSLATOR_API_MODEL,
      DEFAULT_API_MODEL,
    ),
    keyMaxAttempts: Math.round(
      resolveNumberRange(
        env.MANGA_TRANSLATOR_API_KEY_MAX_ATTEMPTS,
        DEFAULT_API_KEY_MAX_ATTEMPTS,
        MIN_API_KEY_MAX_ATTEMPTS,
        MAX_API_KEY_MAX_ATTEMPTS,
      ),
    ),
    retryDelaySeconds: resolveNumberRange(
      env.MANGA_TRANSLATOR_API_RETRY_DELAY_SECONDS,
      DEFAULT_API_RETRY_DELAY_SECONDS,
      MIN_API_RETRY_DELAY_SECONDS,
      MAX_API_RETRY_DELAY_SECONDS,
    ),
    temperature: resolveNullableNumberRange(
      env.MANGA_TRANSLATOR_API_TEMPERATURE,
      DEFAULT_API_TEMPERATURE,
      0,
      2,
    ),
    topP: resolveNullableNumberRange(
      env.MANGA_TRANSLATOR_API_TOP_P,
      DEFAULT_API_TOP_P,
      0,
      1,
    ),
    topK: resolveNullableIntegerRange(
      env.MANGA_TRANSLATOR_API_TOP_K,
      DEFAULT_API_TOP_K,
      1,
      1000,
    ),
    reasoningEffort: resolveNullableReasoningEffort(
      env.MANGA_TRANSLATOR_API_REASONING_EFFORT,
      DEFAULT_API_REASONING_EFFORT,
    ),
    extraBodyJson:
      env.MANGA_TRANSLATOR_API_EXTRA_BODY ?? DEFAULT_API_EXTRA_BODY_JSON,
    customHeadersJson:
      env.MANGA_TRANSLATOR_API_HEADERS ?? DEFAULT_API_CUSTOM_HEADERS_JSON,
  };
  const provider = inferApiProviderPreset(profile.baseUrl);
  return {
    ...profile,
    provider,
    profiles: { [provider]: profile },
  };
}
