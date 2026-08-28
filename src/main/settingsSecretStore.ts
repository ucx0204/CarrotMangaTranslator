import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";
import type { AppSettings } from "../shared/settingsTypes";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../shared/settingsSecrets";
import { parseApiKeys } from "../shared/apiKeySettings";
import type { AppPaths } from "./appPaths";
import {
  commitSettingsPairFiles,
  loadCommittedSettingsPairFiles,
  type SettingsPairFiles,
} from "./settingsPairStorage";
import {
  assertSettingsGeneration,
  isSettingsJsonRecord,
  parseSettingsJsonRecord,
  serializeSettingsJson,
} from "./settingsPairCodec";

export type SettingsSecrets = {
  apiKey?: string;
  tavilyApiKey?: string;
  credentialHeaders?: Record<string, unknown>;
};

type LegacyEncryptedSecretVault = {
  version: 1;
  apiKey?: string;
  tavilyApiKey?: string;
  credentialHeaders?: string;
};

type EncryptedSecretVault = {
  version: 2;
  generation: string;
  apiKey?: string;
  tavilyApiKey?: string;
  credentialHeaders?: string;
};

export type CommittedSettingsPair = {
  generation: string;
  rawSettingsText: string;
  secrets: SettingsSecrets;
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

export async function loadSettingsSecrets(
  paths: AppPaths,
): Promise<SettingsSecrets> {
  const committed = await loadCommittedSettingsPair(paths);
  if (committed) return committed.secrets;

  let publicSettings: Record<string, unknown>;
  try {
    publicSettings = parseSettingsJsonRecord(
      await readFile(paths.settingsPath, "utf8"),
      "Public settings file",
    );
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }

  let vault: LegacyEncryptedSecretVault | EncryptedSecretVault;
  try {
    vault = parseEncryptedVault(
      await readFile(settingsSecretVaultPath(paths), "utf8"),
    );
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw new Error("Encrypted settings secret vault is unreadable.", {
      cause: error,
    });
  }

  if (vault.version === 1) {
    // A v1 vault predates endpoint/credential generation binding. There is no
    // cryptographic or transactional evidence that it belongs to this public
    // settings file, so fail closed and require the user to enter credentials
    // again instead of risking delivery to an older endpoint.
    return {};
  }
  if (publicSettings.secretGeneration !== vault.generation) {
    throw new Error(
      "Public settings and encrypted secrets belong to different generations.",
    );
  }
  return decryptVault(vault);
}

export async function loadCommittedSettingsPair(
  paths: AppPaths,
): Promise<CommittedSettingsPair | null> {
  return loadCommittedSettingsPairFiles(paths, decodeCommittedSettingsPair);
}

export function commitSettingsPair(
  paths: AppPaths,
  publicSettings: Record<string, unknown>,
  secrets: SettingsSecrets,
): Promise<string> {
  const generation = randomUUID();
  const normalized = normalizeSecrets(secrets);
  const publicPayload = {
    ...publicSettings,
    secretGeneration: generation,
  };
  const vault: EncryptedSecretVault = {
    version: 2,
    generation,
    ...(normalized.apiKey ? { apiKey: encryptSecret(normalized.apiKey) } : {}),
    ...(normalized.tavilyApiKey
      ? { tavilyApiKey: encryptSecret(normalized.tavilyApiKey) }
      : {}),
    ...(normalized.credentialHeaders
      ? {
          credentialHeaders: encryptSecret(
            JSON.stringify(normalized.credentialHeaders),
          ),
        }
      : {}),
  };
  const publicText = serializeSettingsJson(publicPayload);
  const vaultText = serializeSettingsJson(vault);
  // Validate the codec and OS decryption path before publishing the pair.
  decodeCommittedSettingsPair({
    generation,
    rawSettingsText: publicText,
    vaultText,
  });
  return commitSettingsPairFiles(paths, {
    generation,
    rawSettingsText: publicText,
    vaultText,
  });
}

export function separateSettingsSecrets(settings: AppSettings): {
  persistentSettings: AppSettings;
  secrets: SettingsSecrets;
} {
  const api = { ...settings.api };
  const apiKey = cleanSecret(api.apiKey);
  delete api.apiKey;
  delete api.apiKeyCount;
  const { publicHeadersJson, credentialHeaders } = splitCredentialHeaders(
    api.customHeadersJson,
  );
  api.customHeadersJson = publicHeadersJson;
  const internetResearch = { ...settings.internetResearch };
  const tavilyApiKey = cleanSecret(internetResearch.tavilyApiKey);
  delete internetResearch.tavilyApiKey;
  return {
    persistentSettings: { ...settings, api, internetResearch },
    secrets: normalizeSecrets({ apiKey, tavilyApiKey, credentialHeaders }),
  };
}

export function attachSettingsSecrets(
  settings: AppSettings,
  secrets: SettingsSecrets,
): AppSettings {
  const publicHeaders = parseHeaderRecord(settings.api.customHeadersJson);
  const headers = {
    ...publicHeaders,
    ...(secrets.credentialHeaders ?? {}),
  };
  return {
    ...settings,
    internetResearch: {
      ...settings.internetResearch,
      ...(secrets.tavilyApiKey ? { tavilyApiKey: secrets.tavilyApiKey } : {}),
    },
    api: {
      ...settings.api,
      ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}),
      customHeadersJson: stringifyHeaderRecord(headers),
    },
  };
}

export function resolveSubmittedSettingsSecrets(
  settings: AppSettings,
  existing: SettingsSecrets,
): { settings: AppSettings; secrets: SettingsSecrets } {
  const submitted = separateSettingsSecrets(settings);
  const apiKey =
    settings.api.apiKey === SETTINGS_SECRET_PRESERVE_SENTINEL
      ? existing.apiKey
      : submitted.secrets.apiKey;
  const tavilyApiKey =
    settings.internetResearch.tavilyApiKey === SETTINGS_SECRET_PRESERVE_SENTINEL
      ? existing.tavilyApiKey
      : submitted.secrets.tavilyApiKey;
  const headers = submitted.secrets.credentialHeaders ?? {};
  const existingHeaders = existing.credentialHeaders ?? {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== SETTINGS_SECRET_PRESERVE_SENTINEL) continue;
    const existingName = Object.keys(existingHeaders).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (existingName) {
      headers[name] = existingHeaders[existingName];
    } else {
      delete headers[name];
    }
  }
  return {
    settings: submitted.persistentSettings,
    secrets: normalizeSecrets({
      apiKey,
      tavilyApiKey,
      credentialHeaders: headers,
    }),
  };
}

export function hasSettingsSecretSentinels(settings: AppSettings): boolean {
  if (settings.api.apiKey === SETTINGS_SECRET_PRESERVE_SENTINEL) return true;
  if (
    settings.internetResearch.tavilyApiKey === SETTINGS_SECRET_PRESERVE_SENTINEL
  ) {
    return true;
  }
  return Object.values(parseHeaderRecord(settings.api.customHeadersJson)).some(
    (value) => value === SETTINGS_SECRET_PRESERVE_SENTINEL,
  );
}

export function maskSettingsSecrets(settings: AppSettings): AppSettings {
  const api = { ...settings.api };
  delete api.apiKeyCount;
  const apiKeyCount = parseApiKeys(settings.api.apiKey).length;
  const headers = parseHeaderRecord(settings.api.customHeadersJson);
  for (const name of Object.keys(headers)) {
    if (isCredentialHeader(name)) {
      headers[name] = SETTINGS_SECRET_PRESERVE_SENTINEL;
    }
  }
  return {
    ...settings,
    internetResearch: {
      ...settings.internetResearch,
      ...(settings.internetResearch.tavilyApiKey
        ? { tavilyApiKey: SETTINGS_SECRET_PRESERVE_SENTINEL }
        : {}),
    },
    api: {
      ...api,
      ...(apiKeyCount > 0
        ? { apiKey: SETTINGS_SECRET_PRESERVE_SENTINEL, apiKeyCount }
        : {}),
      customHeadersJson: stringifyHeaderRecord(headers),
    },
  };
}

export function settingsSecretVaultPath(paths: AppPaths): string {
  return join(dirname(paths.settingsPath), "settings.secrets.json");
}

function decodeCommittedSettingsPair(
  files: SettingsPairFiles,
): CommittedSettingsPair {
  const publicSettings = parseSettingsJsonRecord(
    files.rawSettingsText,
    "Committed public settings",
  );
  const vault = parseEncryptedVault(files.vaultText);
  if (
    vault.version !== 2 ||
    publicSettings.secretGeneration !== files.generation ||
    vault.generation !== files.generation
  ) {
    throw new Error("Committed settings pair generation verification failed.");
  }
  return {
    generation: files.generation,
    rawSettingsText: files.rawSettingsText,
    secrets: decryptVault(vault),
  };
}

function parseEncryptedVault(
  rawText: string,
): LegacyEncryptedSecretVault | EncryptedSecretVault {
  const value = parseSettingsJsonRecord(
    rawText,
    "Encrypted settings secret vault",
  );
  if (value.version !== 1 && value.version !== 2) {
    throw new Error("Encrypted settings secret vault version is unsupported.");
  }
  const fields = parseEncryptedVaultFields(value);
  if (value.version === 1) {
    return { version: 1, ...fields };
  }
  const generation = String(value.generation ?? "");
  assertSettingsGeneration(generation);
  return { version: 2, generation, ...fields };
}

function parseEncryptedVaultFields(value: Record<string, unknown>): {
  apiKey?: string;
  tavilyApiKey?: string;
  credentialHeaders?: string;
} {
  const apiKey = parseOptionalEncryptedField(value.apiKey);
  const tavilyApiKey = parseOptionalEncryptedField(value.tavilyApiKey);
  const credentialHeaders = parseOptionalEncryptedField(
    value.credentialHeaders,
  );
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
    ...(credentialHeaders ? { credentialHeaders } : {}),
  };
}

function parseOptionalEncryptedField(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("Encrypted settings secret vault fields are invalid.");
  }
  return value || undefined;
}

function decryptVault(
  vault: LegacyEncryptedSecretVault | EncryptedSecretVault,
): SettingsSecrets {
  const secrets: SettingsSecrets = {};
  if (vault.apiKey) secrets.apiKey = decryptSecret(vault.apiKey);
  if (vault.tavilyApiKey) {
    secrets.tavilyApiKey = decryptSecret(vault.tavilyApiKey);
  }
  if (vault.credentialHeaders) {
    const parsed = JSON.parse(
      decryptSecret(vault.credentialHeaders),
    ) as unknown;
    if (!isSettingsJsonRecord(parsed)) {
      throw new Error("Encrypted credential headers are invalid.");
    }
    secrets.credentialHeaders = parsed;
  }
  return secrets;
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

function parseHeaderRecord(value: string | undefined): Record<string, unknown> {
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

function normalizeSecrets(secrets: SettingsSecrets): SettingsSecrets {
  const apiKey = cleanSecret(secrets.apiKey);
  const tavilyApiKey = cleanSecret(secrets.tavilyApiKey);
  const credentialHeaders = secrets.credentialHeaders;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
    ...(credentialHeaders && Object.keys(credentialHeaders).length > 0
      ? { credentialHeaders }
      : {}),
  };
}

function cleanSecret(value: unknown): string | undefined {
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

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-backed settings encryption is unavailable.");
  }
  return safeStorage.encryptString(value).toString("base64");
}

function decryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS-backed settings encryption is unavailable.");
  }
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
