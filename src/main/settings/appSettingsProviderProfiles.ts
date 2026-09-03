import {
  API_PROVIDER_PRESET_IDS,
  inferApiProviderPreset,
  isApiProviderPresetId,
  type ApiProviderPresetId,
} from "../../shared/apiProviderPresets";
import {
  DEFAULT_API_KEY_MAX_ATTEMPTS,
  DEFAULT_API_RETRY_DELAY_SECONDS,
  MAX_API_KEY_MAX_ATTEMPTS,
  MAX_API_RETRY_DELAY_SECONDS,
  MIN_API_KEY_MAX_ATTEMPTS,
  MIN_API_RETRY_DELAY_SECONDS,
  normalizeApiKeysText,
} from "../../shared/apiKeySettings";
import type {
  ApiProviderProfileSettings,
  AppSettings,
  GenerationLimitProfiles,
  GenerationLimitSettings,
  ResolvedApiSettings,
} from "../../shared/settingsTypes";
import {
  asRecord,
  resolveContextTokens,
  resolveMaxTokens,
  resolveNullableIntegerRange,
  resolveNullableNumberRange,
  resolveNullableReasoningEffort,
  resolveNonEmptyString,
  resolveNumberRange,
  resolveOpenAiCompatibleBaseUrl,
  resolveOptionalJsonObjectString,
} from "./appSettingsResolvers";
import { normalizeVertexAuthSettings } from "./vertexAuthSettingsNormalize";
import { resolveAppGenerationLimits } from "./appSettingsGenerationLimits";

export function normalizeApiSettings(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): ResolvedApiSettings {
  const provider = resolveApiProvider(api, defaults);
  const rawProfiles = asRecord(api?.profiles) ?? {};
  const profiles = normalizeApiProfiles(api, rawProfiles, defaults, provider);
  const activeProfile =
    profiles[provider] ?? normalizeApiProviderProfile(api, defaults.api);
  profiles[provider] = activeProfile;
  return { ...activeProfile, provider, profiles };
}

function resolveApiProvider(
  api: Record<string, unknown> | null,
  defaults: AppSettings,
): ApiProviderPresetId {
  if (isApiProviderPresetId(api?.provider)) return api.provider;
  const baseUrl =
    typeof api?.baseUrl === "string" ? api.baseUrl : defaults.api.baseUrl;
  return inferApiProviderPreset(baseUrl);
}

function normalizeApiProfiles(
  activeApi: Record<string, unknown> | null,
  rawProfiles: Record<string, unknown>,
  defaults: AppSettings,
  activeProvider: ApiProviderPresetId,
): ResolvedApiSettings["profiles"] {
  const profiles: ResolvedApiSettings["profiles"] = {};
  for (const provider of API_PROVIDER_PRESET_IDS) {
    const profile = normalizeStoredApiProfile({
      activeApi,
      activeProvider,
      defaults,
      provider,
      rawProfile: asRecord(rawProfiles[provider]),
    });
    if (profile) profiles[provider] = profile;
  }
  return profiles;
}

function normalizeStoredApiProfile({
  activeApi,
  activeProvider,
  defaults,
  provider,
  rawProfile,
}: {
  activeApi: Record<string, unknown> | null;
  activeProvider: ApiProviderPresetId;
  defaults: AppSettings;
  provider: ApiProviderPresetId;
  rawProfile: Record<string, unknown> | null;
}): ApiProviderProfileSettings | null {
  const defaultProfile = defaults.api.profiles?.[provider];
  if (!rawProfile && !defaultProfile && provider !== activeProvider)
    return null;
  const activeMirror = provider === activeProvider ? activeApi : null;
  return normalizeApiProviderProfile(
    mergeProfileRecords(rawProfile, activeMirror),
    defaultProfile ?? defaults.api,
  );
}

export function normalizeGenerationLimitProfiles({
  api,
  codex,
  defaults,
  modelProvider,
  raw,
  rawMaxTokens,
  rawContextTokens,
}: {
  api: ResolvedApiSettings;
  codex: AppSettings["codex"];
  defaults: AppSettings;
  modelProvider: AppSettings["modelProvider"];
  raw: unknown;
  rawMaxTokens: unknown;
  rawContextTokens: unknown;
}): GenerationLimitProfiles {
  const record = asRecord(raw) ?? {};
  const defaultProfiles = defaults.generationLimits;
  const apiProfiles = normalizeApiGenerationLimits({
    api,
    defaults,
    defaultProfiles,
    modelProvider,
    rawApi: asRecord(record.api) ?? {},
    rawContextTokens,
    rawMaxTokens,
  });
  return {
    gemma: normalizeGenerationLimits(
      resolveProviderLimitSource(
        asRecord(record.gemma),
        modelProvider === "gemma",
        rawMaxTokens,
        rawContextTokens,
      ),
      defaultProfiles?.gemma ?? resolveAppGenerationLimits("gemma"),
    ),
    codex: normalizeGenerationLimits(
      resolveProviderLimitSource(
        asRecord(record.codex),
        modelProvider === "openai-codex",
        rawMaxTokens,
        rawContextTokens,
      ),
      resolveCodexGenerationLimitFallback(codex, defaults),
    ),
    api: apiProfiles,
  };
}

function normalizeApiGenerationLimits({
  api,
  defaults,
  defaultProfiles,
  modelProvider,
  rawApi,
  rawContextTokens,
  rawMaxTokens,
}: {
  api: ResolvedApiSettings;
  defaults: AppSettings;
  defaultProfiles: GenerationLimitProfiles | undefined;
  modelProvider: AppSettings["modelProvider"];
  rawApi: Record<string, unknown>;
  rawContextTokens: unknown;
  rawMaxTokens: unknown;
}): GenerationLimitProfiles["api"] {
  const profiles: GenerationLimitProfiles["api"] = {};
  for (const provider of API_PROVIDER_PRESET_IDS) {
    const normalized = normalizeApiGenerationLimit({
      activeProvider: api.provider,
      apiProfile: api.profiles[provider],
      defaultProfile: defaultProfiles?.api[provider],
      defaults,
      modelProvider,
      provider,
      rawContextTokens,
      rawMaxTokens,
      rawProfile: asRecord(rawApi[provider]),
    });
    if (normalized) profiles[provider] = normalized;
  }
  profiles[api.provider] ??= resolveAppGenerationLimits(
    "openai-api",
    api.model,
  );
  return profiles;
}

function normalizeApiGenerationLimit({
  activeProvider,
  apiProfile,
  defaultProfile,
  defaults,
  modelProvider,
  provider,
  rawContextTokens,
  rawMaxTokens,
  rawProfile,
}: {
  activeProvider: ApiProviderPresetId;
  apiProfile: ApiProviderProfileSettings | undefined;
  defaultProfile: GenerationLimitSettings | undefined;
  defaults: AppSettings;
  modelProvider: AppSettings["modelProvider"];
  provider: ApiProviderPresetId;
  rawContextTokens: unknown;
  rawMaxTokens: unknown;
  rawProfile: Record<string, unknown> | null;
}): GenerationLimitSettings | null {
  if (
    !rawProfile &&
    !defaultProfile &&
    !apiProfile &&
    provider !== activeProvider
  ) {
    return null;
  }
  const source = resolveProviderLimitSource(
    rawProfile,
    provider === activeProvider && modelProvider === "openai-api",
    rawMaxTokens,
    rawContextTokens,
  );
  return normalizeGenerationLimits(
    source,
    resolveApiGenerationLimitFallback({
      apiProfile,
      defaultProfile,
      defaults,
      provider,
    }),
  );
}

function resolveCodexGenerationLimitFallback(
  codex: AppSettings["codex"],
  defaults: AppSettings,
): GenerationLimitSettings {
  if (codex.model === defaults.codex.model) {
    return (
      defaults.generationLimits?.codex ??
      resolveAppGenerationLimits("openai-codex", codex.model)
    );
  }
  return resolveAppGenerationLimits("openai-codex", codex.model);
}

function resolveApiGenerationLimitFallback({
  apiProfile,
  defaultProfile,
  defaults,
  provider,
}: {
  apiProfile: ApiProviderProfileSettings | undefined;
  defaultProfile: GenerationLimitSettings | undefined;
  defaults: AppSettings;
  provider: ApiProviderPresetId;
}): GenerationLimitSettings {
  const matchesDefaultProfile =
    provider === defaults.api.provider &&
    apiProfile?.model === defaults.api.model;
  if (matchesDefaultProfile && defaultProfile) return defaultProfile;
  return resolveAppGenerationLimits("openai-api", apiProfile?.model);
}

function resolveProviderLimitSource(
  stored: Record<string, unknown> | null,
  useLegacyActive: boolean,
  maxTokens: unknown,
  contextTokens: unknown,
): Record<string, unknown> | null {
  if (stored) return stored;
  return useLegacyActive ? { maxTokens, contextTokens } : null;
}

export function resolveActiveGenerationLimits(
  profiles: GenerationLimitProfiles,
  modelProvider: AppSettings["modelProvider"],
  apiProvider: ApiProviderPresetId,
): GenerationLimitSettings {
  if (modelProvider === "gemma") return profiles.gemma;
  if (modelProvider === "openai-codex") return profiles.codex;
  return profiles.api[apiProvider] ?? profiles.codex;
}

function normalizeApiProviderProfile(
  api: Record<string, unknown> | null,
  fallback: ApiProviderProfileSettings,
): ApiProviderProfileSettings {
  const source = api ?? {};
  const apiKey = normalizeApiKeysText(source.apiKey);
  return {
    baseUrl: resolveOpenAiCompatibleBaseUrl(source.baseUrl, fallback.baseUrl),
    model: resolveNonEmptyString(source.model, fallback.model),
    ...optionalApiKey(apiKey),
    ...normalizeVertexAuthSettings(source),
    keyMaxAttempts: Math.round(
      resolveNumberRange(
        source.keyMaxAttempts,
        withDefault(fallback.keyMaxAttempts, DEFAULT_API_KEY_MAX_ATTEMPTS),
        MIN_API_KEY_MAX_ATTEMPTS,
        MAX_API_KEY_MAX_ATTEMPTS,
      ),
    ),
    retryDelaySeconds: resolveNumberRange(
      source.retryDelaySeconds,
      withDefault(fallback.retryDelaySeconds, DEFAULT_API_RETRY_DELAY_SECONDS),
      MIN_API_RETRY_DELAY_SECONDS,
      MAX_API_RETRY_DELAY_SECONDS,
    ),
    temperature: resolveNullableNumberRange(
      source.temperature,
      withDefault(fallback.temperature, null),
      0,
      2,
    ),
    topP: resolveNullableNumberRange(
      source.topP,
      withDefault(fallback.topP, null),
      0,
      1,
    ),
    topK: resolveNullableIntegerRange(
      source.topK,
      withDefault(fallback.topK, null),
      1,
      1000,
    ),
    reasoningEffort: resolveNullableReasoningEffort(
      source.reasoningEffort,
      withDefault(fallback.reasoningEffort, null),
    ),
    extraBodyJson: resolveOptionalJsonObjectString(
      source.extraBodyJson,
      withDefault(fallback.extraBodyJson, ""),
    ),
    customHeadersJson: resolveOptionalJsonObjectString(
      source.customHeadersJson,
      withDefault(fallback.customHeadersJson, ""),
    ),
  };
}

function optionalApiKey(
  apiKey: string,
): Pick<ApiProviderProfileSettings, "apiKey"> | object {
  return apiKey ? { apiKey } : {};
}

function withDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function normalizeGenerationLimits(
  raw: Record<string, unknown> | null,
  fallback: GenerationLimitSettings,
): GenerationLimitSettings {
  return {
    maxTokens: resolveMaxTokens(raw?.maxTokens, fallback.maxTokens),
    contextTokens: resolveContextTokens(
      raw?.contextTokens ?? raw?.ctx,
      fallback.contextTokens,
    ),
  };
}

function mergeProfileRecords(
  stored: Record<string, unknown> | null,
  active: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!stored && !active) return null;
  return { ...(stored ?? {}), ...(active ?? {}) };
}
