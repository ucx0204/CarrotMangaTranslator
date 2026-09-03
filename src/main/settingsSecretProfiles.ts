import type { AppSettings } from "../shared/settingsTypes";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../shared/settingsSecrets";
import { parseApiKeys } from "../shared/apiKeySettings";
import {
  API_PROVIDER_PRESET_IDS,
  inferApiProviderPreset,
  type ApiProviderPresetId,
} from "../shared/apiProviderPresets";
import { isSettingsJsonRecord } from "./settingsPairCodec";

export type ApiProfileSecrets = {
  apiKey?: string;
  credentialHeaders?: Record<string, unknown>;
};

export type SettingsSecrets = ApiProfileSecrets & {
  /** Provider-isolated credentials. Top-level fields are read-only legacy aliases. */
  apiProfiles?: Partial<Record<ApiProviderPresetId, ApiProfileSecrets>>;
  tavilyApiKey?: string;
};

const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

export function resolveActiveApiProvider(
  settings: AppSettings,
): ApiProviderPresetId {
  return settings.api.provider ?? inferApiProviderPreset(settings.api.baseUrl);
}

export function readActiveApiProfile(settings: AppSettings) {
  const { provider: _provider, profiles: _profiles, ...profile } = settings.api;
  return profile;
}

export function readApiProfile(
  settings: AppSettings,
  candidate: ApiProviderPresetId,
  activeProvider = resolveActiveApiProvider(settings),
) {
  const stored = settings.api.profiles?.[candidate];
  if (candidate !== activeProvider) return stored;
  return { ...(stored ?? {}), ...readActiveApiProfile(settings) };
}

export function separateApiProfileSecrets(profile: AppSettings["api"]): {
  profile: AppSettings["api"];
  secrets: ApiProfileSecrets;
} {
  const publicProfile = { ...profile };
  delete publicProfile.provider;
  delete publicProfile.profiles;
  const apiKey = cleanSecret(publicProfile.apiKey);
  delete publicProfile.apiKey;
  delete publicProfile.apiKeyCount;
  const { publicHeadersJson, credentialHeaders } = splitCredentialHeaders(
    publicProfile.customHeadersJson,
  );
  publicProfile.customHeadersJson = publicHeadersJson;
  return {
    profile: publicProfile,
    secrets: normalizeApiProfileSecrets({ apiKey, credentialHeaders }),
  };
}

export function attachApiProfileSecrets(
  profile: AppSettings["api"],
  secrets: ApiProfileSecrets,
): AppSettings["api"] {
  const headers = {
    ...parseHeaderRecord(profile.customHeadersJson),
    ...(secrets.credentialHeaders ?? {}),
  };
  return {
    ...profile,
    ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}),
    customHeadersJson: stringifyHeaderRecord(headers),
  };
}

export function maskApiProfileSecrets(
  profile: AppSettings["api"],
): AppSettings["api"] {
  const masked = { ...profile };
  delete masked.apiKeyCount;
  const apiKeyCount = parseApiKeys(profile.apiKey).length;
  const headers = parseHeaderRecord(profile.customHeadersJson);
  for (const name of Object.keys(headers)) {
    if (isCredentialHeader(name)) {
      headers[name] = SETTINGS_SECRET_PRESERVE_SENTINEL;
    }
  }
  return {
    ...masked,
    ...(apiKeyCount > 0
      ? { apiKey: SETTINGS_SECRET_PRESERVE_SENTINEL, apiKeyCount }
      : {}),
    customHeadersJson: stringifyHeaderRecord(headers),
  };
}

export function resolveApiProfileSecrets(
  secrets: SettingsSecrets,
  candidate: ApiProviderPresetId,
  activeProvider: ApiProviderPresetId,
): ApiProfileSecrets {
  const isolated = secrets.apiProfiles?.[candidate] ?? {};
  if (candidate !== activeProvider) return isolated;
  return normalizeApiProfileSecrets({
    apiKey: secrets.apiKey ?? isolated.apiKey,
    credentialHeaders: {
      ...(isolated.credentialHeaders ?? {}),
      ...(secrets.credentialHeaders ?? {}),
    },
  });
}

export function resolveSubmittedApiProfileSecrets(
  submittedProfile: AppSettings["api"] | undefined,
  submitted: ApiProfileSecrets,
  existing: ApiProfileSecrets,
): ApiProfileSecrets {
  const apiKey =
    submittedProfile?.apiKey === SETTINGS_SECRET_PRESERVE_SENTINEL
      ? existing.apiKey
      : submitted.apiKey;
  const headers = { ...(submitted.credentialHeaders ?? {}) };
  restorePreservedHeaders(headers, existing.credentialHeaders ?? {});
  return normalizeApiProfileSecrets({ apiKey, credentialHeaders: headers });
}

function restorePreservedHeaders(
  headers: Record<string, unknown>,
  existingHeaders: Record<string, unknown>,
): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value !== SETTINGS_SECRET_PRESERVE_SENTINEL) continue;
    const existingName = Object.keys(existingHeaders).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (existingName) headers[name] = existingHeaders[existingName];
    else delete headers[name];
  }
}

export function hasApiProfileSecrets(secrets: ApiProfileSecrets): boolean {
  return Boolean(
    secrets.apiKey ||
    (secrets.credentialHeaders &&
      Object.keys(secrets.credentialHeaders).length > 0),
  );
}

function splitCredentialHeaders(value: string | undefined): {
  publicHeadersJson: string;
  credentialHeaders?: Record<string, unknown>;
} {
  const headers = parseHeaderRecord(value);
  const publicHeaders: Record<string, unknown> = {};
  const credentialHeaders: Record<string, unknown> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    (isCredentialHeader(name) ? credentialHeaders : publicHeaders)[name] =
      headerValue;
  }
  return {
    publicHeadersJson: stringifyHeaderRecord(publicHeaders),
    ...(Object.keys(credentialHeaders).length > 0 ? { credentialHeaders } : {}),
  };
}

export function parseHeaderRecord(
  value: string | undefined,
): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isSettingsJsonRecord(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function stringifyHeaderRecord(headers: Record<string, unknown>): string {
  return Object.keys(headers).length > 0
    ? JSON.stringify(headers, null, 2)
    : "";
}

export function normalizeSecrets(secrets: SettingsSecrets): SettingsSecrets {
  const apiKey = cleanSecret(secrets.apiKey);
  const tavilyApiKey = cleanSecret(secrets.tavilyApiKey);
  const credentialHeaders = secrets.credentialHeaders;
  const apiProfiles = normalizeApiProfiles(secrets.apiProfiles);
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
    ...(credentialHeaders && Object.keys(credentialHeaders).length > 0
      ? { credentialHeaders }
      : {}),
    ...(Object.keys(apiProfiles).length > 0 ? { apiProfiles } : {}),
  };
}

function normalizeApiProfiles(
  rawProfiles: SettingsSecrets["apiProfiles"],
): NonNullable<SettingsSecrets["apiProfiles"]> {
  const profiles: NonNullable<SettingsSecrets["apiProfiles"]> = {};
  for (const provider of API_PROVIDER_PRESET_IDS) {
    const profile = normalizeApiProfileSecrets(rawProfiles?.[provider] ?? {});
    if (hasApiProfileSecrets(profile)) profiles[provider] = profile;
  }
  return profiles;
}

export function normalizeApiProfileSecrets(
  secrets: ApiProfileSecrets,
): ApiProfileSecrets {
  const apiKey = cleanSecret(secrets.apiKey);
  const credentialHeaders = secrets.credentialHeaders;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(credentialHeaders && Object.keys(credentialHeaders).length > 0
      ? { credentialHeaders }
      : {}),
  };
}

export function cleanSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isCredentialHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    CREDENTIAL_HEADER_NAMES.has(normalized) ||
    normalized.endsWith("-api-key") ||
    normalized.endsWith("-token")
  );
}
