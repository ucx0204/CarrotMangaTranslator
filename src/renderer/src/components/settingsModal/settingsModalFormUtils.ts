import type {
  ApiReasoningEffort,
  AppSettings,
  CodexReasoningEffort,
  FluxBackend,
  GemmaVramMode,
  InpaintingModel,
  LlamaRuntimeProfile,
  ModelProvider,
  ModelSource,
  OcrDevice,
  OcrGpuBackend,
  OcrQualityMode,
} from "../../../../shared/settingsTypes";
import { coerceOpenAiCompatibleBaseUrl } from "../../../../shared/apiSettings";
import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
  MODEL_PRESETS,
  resolveModelPreset,
  type ModelPresetId,
} from "../settingsOptions";

export type SettingsFormValues = {
  modelProvider: ModelProvider;
  modelSource: ModelSource;
  selectedPreset: ModelPresetId;
  customModelRepo: string;
  customModelFile: string;
  localModelPath: string;
  localMmprojPath: string;
  customVramMode: GemmaVramMode;
  llamaRuntimeProfile: LlamaRuntimeProfile;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexOauthPort: string;
  apiBaseUrl: string;
  apiModel: string;
  apiKey: string;
  apiTemperature: string;
  apiTopP: string;
  apiTopK: string;
  apiReasoningEffort: ApiReasoningEffort | "";
  apiExtraBodyJson: string;
  apiCustomHeadersJson: string;
  ocrDevice: OcrDevice;
  ocrGpuBackend: OcrGpuBackend;
  ocrQualityMode: OcrQualityMode;
  inpaintingModel: InpaintingModel;
  fluxBackend: FluxBackend;
  maxTokens: string;
  contextTokens: string;
};

export type SettingsDraft = ReturnType<typeof resolveSettingsDraft>;

export function createSettingsFormValues(
  settings: AppSettings,
): SettingsFormValues {
  return {
    modelProvider: settings.modelProvider,
    modelSource: settings.gemma.modelSource,
    selectedPreset: resolveModelPreset(
      settings.gemma.modelRepo,
      settings.gemma.modelFile,
    ),
    customModelRepo: settings.gemma.modelRepo,
    customModelFile: settings.gemma.modelFile,
    localModelPath: settings.gemma.localModelPath ?? "",
    localMmprojPath: settings.gemma.localMmprojPath ?? "",
    customVramMode: settings.gemma.vramMode,
    llamaRuntimeProfile: settings.gemma.llamaRuntimeProfile ?? "cuda12",
    codexModel: settings.codex.model,
    codexReasoningEffort: settings.codex.reasoningEffort,
    codexOauthPort: String(settings.codex.oauthPort),
    apiBaseUrl: settings.api.baseUrl,
    apiModel: settings.api.model,
    apiKey: settings.api.apiKey ?? "",
    apiTemperature: formatNullableNumberInput(settings.api.temperature),
    apiTopP: formatNullableNumberInput(settings.api.topP),
    apiTopK: formatNullableNumberInput(settings.api.topK),
    apiReasoningEffort: settings.api.reasoningEffort ?? "",
    apiExtraBodyJson: settings.api.extraBodyJson ?? "",
    apiCustomHeadersJson: settings.api.customHeadersJson ?? "",
    ocrDevice: settings.ocr.device,
    ocrGpuBackend: settings.ocr.gpuBackend ?? "cuda",
    ocrQualityMode: settings.ocr.qualityMode ?? "minimum",
    ...resolveInpaintingFormValues(settings),
    maxTokens: String(settings.maxTokens),
    contextTokens: String(settings.ctx),
  };
}

function resolveInpaintingFormValues(
  settings: AppSettings,
): Pick<SettingsFormValues, "inpaintingModel" | "fluxBackend"> {
  return {
    inpaintingModel: settings.inpainting?.model ?? "flux-klein",
    fluxBackend: settings.inpainting?.fluxBackend ?? "cuda-native",
  };
}

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
  const apiExtraBodyValidation = validateJsonObjectInput(
    values.apiExtraBodyJson,
  );
  const apiCustomHeadersValidation = validateCustomHeadersInput(
    values.apiCustomHeadersJson,
  );

  return {
    normalizedApiBaseUrl: coerceOpenAiCompatibleBaseUrl(values.apiBaseUrl),
    trimmedApiModel: values.apiModel.trim(),
    trimmedApiKey: values.apiKey.trim(),
    parsedApiTemperature,
    parsedApiTopP,
    parsedApiTopK,
    apiExtraBodyValidation,
    apiCustomHeadersValidation,
    apiBaseUrlValid: Boolean(coerceOpenAiCompatibleBaseUrl(values.apiBaseUrl)),
    apiAdvancedSettingsValid: resolveApiAdvancedSettingsValid({
      apiCustomHeadersValidation,
      apiExtraBodyValidation,
      parsedApiTemperature,
      parsedApiTopK,
      parsedApiTopP,
    }),
  };
}

function resolveApiAdvancedSettingsValid({
  apiCustomHeadersValidation,
  apiExtraBodyValidation,
  parsedApiTemperature,
  parsedApiTopK,
  parsedApiTopP,
}: {
  apiCustomHeadersValidation: ValidationResult;
  apiExtraBodyValidation: ValidationResult;
  parsedApiTemperature: ValidationResult;
  parsedApiTopK: ValidationResult;
  parsedApiTopP: ValidationResult;
}): boolean {
  return (
    parsedApiTemperature.valid &&
    parsedApiTopP.valid &&
    parsedApiTopK.valid &&
    apiExtraBodyValidation.valid &&
    apiCustomHeadersValidation.valid
  );
}

type ValidationResult = {
  valid: boolean;
};

export function getApiAdvancedSettingsMessage(
  draft: SettingsDraft,
): string | undefined {
  return (
    draft.parsedApiTemperature.message ??
    draft.parsedApiTopP.message ??
    draft.parsedApiTopK.message ??
    draft.apiExtraBodyValidation.message ??
    draft.apiCustomHeadersValidation.message
  );
}

export function isSettingsFormSubmittable(
  values: SettingsFormValues,
  draft: SettingsDraft,
): boolean {
  if (!draft.maxTokensValid || !draft.contextTokensValid) {
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

function formatNullableNumberInput(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function parseNullableNumberInput(
  value: string,
  min: number,
  max: number,
): { valid: boolean; value: number | null; message?: string } {
  const text = value.trim();
  if (!text) {
    return { valid: true, value: null };
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return {
      valid: false,
      value: null,
      message: `API 숫자 설정은 ${min} 이상 ${max} 이하이어야 합니다.`,
    };
  }
  return { valid: true, value: parsed };
}

function parseNullableIntegerInput(
  value: string,
  min: number,
  max: number,
): { valid: boolean; value: number | null; message?: string } {
  const parsed = parseNullableNumberInput(value, min, max);
  if (!parsed.valid || parsed.value === null) {
    return parsed;
  }
  if (!Number.isInteger(parsed.value)) {
    return {
      valid: false,
      value: null,
      message: `API 정수 설정은 ${min} 이상 ${max} 이하의 정수여야 합니다.`,
    };
  }
  return parsed;
}

function validateJsonObjectInput(value: string): {
  valid: boolean;
  message?: string;
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
      message: "API JSON 설정은 올바른 객체 JSON이어야 합니다.",
    };
  }
  return { valid: false, message: "API JSON 설정은 객체 JSON이어야 합니다." };
}

function validateCustomHeadersInput(value: string): {
  valid: boolean;
  message?: string;
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
  message?: string;
} {
  for (const [name, headerValue] of Object.entries(headers)) {
    const blockedMessage = validateCustomHeaderName(name);
    if (blockedMessage) {
      return { valid: false, message: blockedMessage };
    }
    if (!isCustomHeaderValue(headerValue)) {
      return {
        valid: false,
        message: "Custom headers 값은 문자열, 숫자, boolean만 허용됩니다.",
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
    return `${name} 헤더는 Custom headers에서 덮어쓸 수 없습니다.`;
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
