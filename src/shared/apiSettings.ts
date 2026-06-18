import { DEFAULT_API_BASE_URL } from "./modelPresets";

export function coerceOpenAiCompatibleBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (_error) {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/+$/g, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/g, "");

  return url.toString().replace(/\/$/g, "");
}

export function resolveOpenAiCompatibleBaseUrl(
  value: unknown,
  fallback = DEFAULT_API_BASE_URL,
): string {
  return (
    coerceOpenAiCompatibleBaseUrl(value) ??
    coerceOpenAiCompatibleBaseUrl(fallback) ??
    DEFAULT_API_BASE_URL
  );
}

export function isOfficialOpenAiApiBaseUrl(value: unknown): boolean {
  const baseUrl = coerceOpenAiCompatibleBaseUrl(value);
  if (!baseUrl) {
    return false;
  }

  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "api.openai.com";
  } catch (_error) {
    return false;
  }
}

export function isValidOpenAiCompatibleBaseUrl(value: unknown): boolean {
  return coerceOpenAiCompatibleBaseUrl(value) !== null;
}
