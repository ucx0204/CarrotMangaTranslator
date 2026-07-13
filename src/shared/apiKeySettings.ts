export const DEFAULT_API_KEY_MAX_ATTEMPTS = 5;
export const MIN_API_KEY_MAX_ATTEMPTS = 1;
export const MAX_API_KEY_MAX_ATTEMPTS = 20;
export const DEFAULT_API_RETRY_DELAY_SECONDS = 1;
export const MIN_API_RETRY_DELAY_SECONDS = 0;
export const MAX_API_RETRY_DELAY_SECONDS = 300;
export const MAX_API_KEYS = 100;
export const MAX_API_KEYS_TEXT_LENGTH = 65_535;

export function parseApiKeys(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  const keys = value
    .split(/\r?\n/g)
    .map((key) => key.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

export function normalizeApiKeysText(value: unknown): string {
  return parseApiKeys(value).join("\n");
}
