import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { safeStorage } from "electron";
import type { AppSettings } from "../shared/settingsTypes";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../shared/settingsSecrets";
import type { AppPaths } from "./appPaths";

type SettingsSecrets = {
  apiKey?: string;
  credentialHeaders?: Record<string, unknown>;
};

type EncryptedSecretVault = {
  version: 1;
  apiKey?: string;
  credentialHeaders?: string;
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
  let vault: EncryptedSecretVault;
  try {
    vault = JSON.parse(
      await readFile(settingsSecretVaultPath(paths), "utf8"),
    ) as EncryptedSecretVault;
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw new Error("Encrypted settings secret vault is unreadable.", {
      cause: error,
    });
  }
  if (vault.version !== 1) {
    throw new Error("Encrypted settings secret vault version is unsupported.");
  }
  const secrets: SettingsSecrets = {};
  if (vault.apiKey) secrets.apiKey = decryptSecret(vault.apiKey);
  if (vault.credentialHeaders) {
    const parsed = JSON.parse(
      decryptSecret(vault.credentialHeaders),
    ) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("Encrypted credential headers are invalid.");
    }
    secrets.credentialHeaders = parsed;
  }
  return secrets;
}

export async function saveSettingsSecrets(
  paths: AppPaths,
  secrets: SettingsSecrets,
): Promise<void> {
  const normalized = normalizeSecrets(secrets);
  const vaultPath = settingsSecretVaultPath(paths);
  if (!normalized.apiKey && !normalized.credentialHeaders) {
    await rm(vaultPath, { force: true });
    return;
  }
  const vault: EncryptedSecretVault = {
    version: 1,
    ...(normalized.apiKey ? { apiKey: encryptSecret(normalized.apiKey) } : {}),
    ...(normalized.credentialHeaders
      ? {
          credentialHeaders: encryptSecret(
            JSON.stringify(normalized.credentialHeaders),
          ),
        }
      : {}),
  };
  await writeRestrictedJsonFile(vaultPath, vault);
}

export function separateSettingsSecrets(settings: AppSettings): {
  persistentSettings: AppSettings;
  secrets: SettingsSecrets;
} {
  const api = { ...settings.api };
  const apiKey = cleanSecret(api.apiKey);
  delete api.apiKey;
  const { publicHeadersJson, credentialHeaders } = splitCredentialHeaders(
    api.customHeadersJson,
  );
  api.customHeadersJson = publicHeadersJson;
  return {
    persistentSettings: { ...settings, api },
    secrets: normalizeSecrets({ apiKey, credentialHeaders }),
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
    secrets: normalizeSecrets({ apiKey, credentialHeaders: headers }),
  };
}

export function maskSettingsSecrets(settings: AppSettings): AppSettings {
  const headers = parseHeaderRecord(settings.api.customHeadersJson);
  for (const name of Object.keys(headers)) {
    if (isCredentialHeader(name)) {
      headers[name] = SETTINGS_SECRET_PRESERVE_SENTINEL;
    }
  }
  return {
    ...settings,
    api: {
      ...settings.api,
      ...(settings.api.apiKey
        ? { apiKey: SETTINGS_SECRET_PRESERVE_SENTINEL }
        : {}),
      customHeadersJson: stringifyHeaderRecord(headers),
    },
  };
}

export function settingsSecretVaultPath(paths: AppPaths): string {
  return join(dirname(paths.settingsPath), "settings.secrets.json");
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
    return isRecord(parsed) ? parsed : {};
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
  const credentialHeaders = secrets.credentialHeaders;
  return {
    ...(apiKey ? { apiKey } : {}),
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

async function writeRestrictedJsonFile(
  filePath: string,
  payload: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tmpPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
