import type { TFunction } from "i18next";
import { coerceOpenAiCompatibleBaseUrl } from "../../../../shared/apiSettings";
import { isValidLanguageCodeInput } from "../../../../shared/translationLanguages";
import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
} from "../../../../shared/modelPresets";
import { MODEL_PRESETS } from "../settingsOptions";
import type { SettingsFormValues } from "./settingsModalFormValues";
import {
  MAX_API_KEY_MAX_ATTEMPTS,
  MAX_API_KEYS,
  MAX_API_RETRY_DELAY_SECONDS,
  MIN_API_KEY_MAX_ATTEMPTS,
  MIN_API_RETRY_DELAY_SECONDS,
  normalizeApiKeysText,
  parseApiKeys,
} from "../../../../shared/apiKeySettings";

export type SettingsDraft = ReturnType<typeof resolveSettingsDraft>;

export function resolveSettingsDraft(values: SettingsFormValues) {
  const activePreset = resolveActiveModelPreset(values);
  const apiDraft = resolveApiDraft(values);
  const parsedCodexOauthPort = Number(values.codexOauthPort);
  const parsedMaxTokens = Number(values.maxTokens);
  const parsedContextTokens = Number(values.contextTokens);

  return {
    activePreset,
    ...resolveModelDraft(values, activePreset),
    ...apiDraft,
    trimmedLocalModelPath: values.localModelPath.trim(),
    trimmedLocalMmprojPath: values.localMmprojPath.trim(),
    trimmedCodexModel: values.codexModel.trim(),
    parsedCodexOauthPort,
    parsedMaxTokens,
    parsedContextTokens,
    codexOauthPortValid: isValidPort(parsedCodexOauthPort),
    maxTokensValid: isValidMaxTokens(parsedMaxTokens),
    contextTokensValid: isValidContextTokens(parsedContextTokens),
    sourceLanguageValid: isValidLanguageCodeInput(values.sourceLanguage),
    targetLanguageValid: isValidLanguageCodeInput(values.targetLanguage),
  };
}

function resolveActiveModelPreset(values: SettingsFormValues) {
  return values.modelSource === "huggingface" &&
    values.selectedPreset !== "custom"
    ? MODEL_PRESETS[values.selectedPreset]
    : null;
}

function resolveModelDraft(
  values: SettingsFormValues,
  activePreset: ReturnType<typeof resolveActiveModelPreset>,
) {
  return {
    trimmedModelRepo: (
      activePreset?.modelRepo ?? values.customModelRepo
    ).trim(),
    trimmedModelFile: (
      activePreset?.modelFile ?? values.customModelFile
    ).trim(),
    trimmedMmprojRepo: activePreset?.mmprojRepo,
    trimmedMmprojFile: activePreset?.mmprojFile,
    selectedVramMode: activePreset?.vramMode ?? values.customVramMode,
  };
}

function resolveApiDraft(values: SettingsFormValues) {
  const parsedApiTemperature = parseNullableNumberInput(
    values.apiTemperature,
    0,
    2,
  );
  const parsedApiTopP = parseNullableNumberInput(values.apiTopP, 0, 1);
  const parsedApiTopK = parseNullableIntegerInput(values.apiTopK, 1, 1000);
  const parsedApiKeyMaxAttempts = parseRequiredIntegerInput(
    values.apiKeyMaxAttempts,
    MIN_API_KEY_MAX_ATTEMPTS,
    MAX_API_KEY_MAX_ATTEMPTS,
  );
  const parsedApiRetryDelaySeconds = parseRequiredNumberInput(
    values.apiRetryDelaySeconds,
    MIN_API_RETRY_DELAY_SECONDS,
    MAX_API_RETRY_DELAY_SECONDS,
  );
  const apiKeysValidation = validateApiKeysInput(values.apiKey);
  const apiExtraBodyValidation = validateJsonObjectInput(
    values.apiExtraBodyJson,
  );
  const apiCustomHeadersValidation = validateCustomHeadersInput(
    values.apiCustomHeadersJson,
  );

  return {
    normalizedApiBaseUrl: coerceOpenAiCompatibleBaseUrl(values.apiBaseUrl),
    trimmedApiModel: values.apiModel.trim(),
    trimmedApiKey: normalizeApiKeysText(values.apiKey),
    parsedApiKeyMaxAttempts: parsedApiKeyMaxAttempts.value,
    parsedApiRetryDelaySeconds: parsedApiRetryDelaySeconds.value,
    apiKeyMaxAttemptsValidation: parsedApiKeyMaxAttempts,
    apiRetryDelaySecondsValidation: parsedApiRetryDelaySeconds,
    apiKeysValidation,
    parsedApiTemperature,
    parsedApiTopP,
    parsedApiTopK,
    apiExtraBodyValidation,
    apiCustomHeadersValidation,
    apiBaseUrlValid: Boolean(coerceOpenAiCompatibleBaseUrl(values.apiBaseUrl)),
    apiAdvancedSettingsValid: resolveApiAdvancedSettingsValid({
      apiCustomHeadersValidation,
      apiExtraBodyValidation,
      apiKeysValidation,
      parsedApiTemperature,
      parsedApiKeyMaxAttempts,
      parsedApiRetryDelaySeconds,
      parsedApiTopK,
      parsedApiTopP,
    }),
  };
}

function resolveApiAdvancedSettingsValid({
  apiCustomHeadersValidation,
  apiExtraBodyValidation,
  apiKeysValidation,
  parsedApiTemperature,
  parsedApiKeyMaxAttempts,
  parsedApiRetryDelaySeconds,
  parsedApiTopK,
  parsedApiTopP,
}: {
  apiCustomHeadersValidation: ValidationResult;
  apiExtraBodyValidation: ValidationResult;
  apiKeysValidation: ValidationResult;
  parsedApiTemperature: ValidationResult;
  parsedApiKeyMaxAttempts: ValidationResult;
  parsedApiRetryDelaySeconds: ValidationResult;
  parsedApiTopK: ValidationResult;
  parsedApiTopP: ValidationResult;
}): boolean {
  return (
    parsedApiTemperature.valid &&
    parsedApiTopP.valid &&
    parsedApiTopK.valid &&
    parsedApiKeyMaxAttempts.valid &&
    parsedApiRetryDelaySeconds.valid &&
    apiKeysValidation.valid &&
    apiExtraBodyValidation.valid &&
    apiCustomHeadersValidation.valid
  );
}

type ValidationResult = {
  valid: boolean;
  messageKey?: string;
  messageValues?: Record<string, string | number>;
};

export function getApiAdvancedSettingsMessage(
  draft: SettingsDraft,
  t: TFunction<"components">,
): string | undefined {
  const invalid = [
    draft.parsedApiTemperature,
    draft.parsedApiTopP,
    draft.parsedApiTopK,
    draft.apiKeyMaxAttemptsValidation,
    draft.apiRetryDelaySecondsValidation,
    draft.apiKeysValidation,
    draft.apiExtraBodyValidation,
    draft.apiCustomHeadersValidation,
  ].find((result) => result.messageKey);
  return invalid?.messageKey
    ? t(invalid.messageKey, invalid.messageValues)
    : undefined;
}

export function isSettingsFormSubmittable(
  values: SettingsFormValues,
  draft: SettingsDraft,
): boolean {
  if (!draft.maxTokensValid || !draft.contextTokensValid) {
    return false;
  }
  // 잘못된 언어 코드는 normalize가 조용히 되돌리므로 저장 전에 막는다.
  if (!draft.sourceLanguageValid || !draft.targetLanguageValid) {
    return false;
  }
  if (values.modelProvider === "openai-codex") {
    return Boolean(draft.trimmedCodexModel && draft.codexOauthPortValid);
  }
  if (values.modelProvider === "openai-api") {
    return Boolean(
      draft.apiBaseUrlValid &&
      draft.trimmedApiModel &&
      draft.apiAdvancedSettingsValid,
    );
  }
  return isGemmaSettingsReady(values, draft);
}

function isGemmaSettingsReady(
  values: SettingsFormValues,
  draft: SettingsDraft,
): boolean {
  return values.modelSource === "local"
    ? Boolean(draft.trimmedLocalModelPath)
    : Boolean(draft.trimmedModelRepo && draft.trimmedModelFile);
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isValidMaxTokens(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_MAX_TOKENS &&
    value <= MAX_MAX_TOKENS
  );
}

function isValidContextTokens(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_CONTEXT_TOKENS;
}

function parseNullableNumberInput(
  value: string,
  min: number,
  max: number,
): ValidationResult & { value: number | null } {
  const text = value.trim();
  if (!text) {
    return { valid: true, value: null };
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return {
      valid: false,
      value: null,
      messageKey: "settings.validation.apiNumberRange",
      messageValues: { min, max },
    };
  }
  return { valid: true, value: parsed };
}

function parseNullableIntegerInput(
  value: string,
  min: number,
  max: number,
): ValidationResult & { value: number | null } {
  const parsed = parseNullableNumberInput(value, min, max);
  if (!parsed.valid || parsed.value === null) {
    return parsed;
  }
  if (!Number.isInteger(parsed.value)) {
    return {
      valid: false,
      value: null,
      messageKey: "settings.validation.apiIntegerRange",
      messageValues: { min, max },
    };
  }
  return parsed;
}

function parseRequiredNumberInput(
  value: string,
  min: number,
  max: number,
): ValidationResult & { value: number } {
  const parsed = parseNullableNumberInput(value, min, max);
  if (parsed.valid && parsed.value !== null) {
    return { valid: true, value: parsed.value };
  }
  return {
    valid: false,
    value: min,
    messageKey: parsed.messageKey ?? "settings.validation.apiNumberRange",
    messageValues: parsed.messageValues ?? { min, max },
  };
}

function parseRequiredIntegerInput(
  value: string,
  min: number,
  max: number,
): ValidationResult & { value: number } {
  const parsed = parseNullableIntegerInput(value, min, max);
  if (parsed.valid && parsed.value !== null) {
    return { valid: true, value: parsed.value };
  }
  return {
    valid: false,
    value: min,
    messageKey: parsed.messageKey ?? "settings.validation.apiIntegerRange",
    messageValues: parsed.messageValues ?? { min, max },
  };
}

function validateApiKeysInput(value: string): ValidationResult {
  const count = parseApiKeys(value).length;
  return count <= MAX_API_KEYS
    ? { valid: true }
    : {
        valid: false,
        messageKey: "settings.validation.apiKeyCount",
        messageValues: { max: MAX_API_KEYS },
      };
}

function validateJsonObjectInput(value: string): {
  valid: boolean;
  messageKey?: string;
  messageValues?: Record<string, string | number>;
} {
  const text = value.trim();
  if (!text) {
    return { valid: true };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { valid: true };
    }
  } catch (_error) {
    return {
      valid: false,
      messageKey: "settings.validation.apiJsonInvalid",
    };
  }
  return {
    valid: false,
    messageKey: "settings.validation.apiJsonObject",
  };
}

function validateCustomHeadersInput(value: string): {
  valid: boolean;
  messageKey?: string;
  messageValues?: Record<string, string | number>;
} {
  const base = validateJsonObjectInput(value);
  if (!base.valid || !value.trim()) {
    return base;
  }
  return validateCustomHeaderEntries(
    JSON.parse(value) as Record<string, unknown>,
  );
}

function validateCustomHeaderEntries(headers: Record<string, unknown>): {
  valid: boolean;
  messageKey?: string;
  messageValues?: Record<string, string | number>;
} {
  for (const [name, headerValue] of Object.entries(headers)) {
    const blockedHeaderName = validateCustomHeaderName(name);
    if (blockedHeaderName) {
      return {
        valid: false,
        messageKey: "settings.validation.customHeaderBlocked",
        messageValues: { name: blockedHeaderName },
      };
    }
    if (!isCustomHeaderValue(headerValue)) {
      return {
        valid: false,
        messageKey: "settings.validation.customHeaderValue",
      };
    }
  }
  return { valid: true };
}

function validateCustomHeaderName(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (
    [
      "authorization",
      "content-type",
      "host",
      "content-length",
      "cookie",
      "set-cookie",
    ].includes(normalized)
  ) {
    return name;
  }
  return null;
}

function isCustomHeaderValue(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
