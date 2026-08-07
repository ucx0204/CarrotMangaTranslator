import { MAX_API_KEYS, parseApiKeys } from "../shared/apiKeySettings";
import { readBoundedResponseText } from "./httpResponseBudget";
import { MAX_MODEL_DISCOVERY_JSON_BYTES } from "./networkBudgets";
import {
  DISCOVERY_TIMEOUT_MS,
  type FetchLike,
  type JsonRecord,
  readRecord,
} from "./apiModelDiscoveryCommon";

export async function fetchJsonWithKeys(
  url: string,
  rawKeys: string,
  buildHeaders: (key: string) => Record<string, string>,
  fetchImpl: FetchLike,
  allowMissingKey = false,
): Promise<JsonRecord> {
  const parsedKeys = parseApiKeys(rawKeys);
  assertKeyCount(parsedKeys);
  const keys = parsedKeys.length > 0 ? parsedKeys : [""];
  return fetchJsonUsingParsedKeys(
    url,
    keys,
    buildHeaders,
    fetchImpl,
    allowMissingKey,
  );
}

export async function fetchJsonUsingParsedKeys(
  url: string,
  keys: string[],
  buildHeaders: (key: string) => Record<string, string>,
  fetchImpl: FetchLike,
  allowMissingKey = false,
  init: RequestInit = {},
): Promise<JsonRecord> {
  assertHasKey(keys, allowMissingKey);
  assertKeyCount(keys);
  let lastError: unknown;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    try {
      const result = await fetchJsonOnce(
        url,
        key,
        keys,
        buildHeaders,
        fetchImpl,
        init,
      );
      promoteWorkingKey(keys, index);
      return result;
    } catch (error) {
      if (
        isDiscoveryNonRetriable(error) ||
        isResponseBudgetError(error) ||
        error instanceof SyntaxError
      ) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("모델 목록을 불러오지 못했습니다.");
}

function assertKeyCount(keys: string[]): void {
  if (keys.length > MAX_API_KEYS) {
    throw new Error(`API 키는 최대 ${MAX_API_KEYS}개까지 사용할 수 있습니다.`);
  }
}

function promoteWorkingKey(keys: string[], index: number): void {
  if (index <= 0) return;
  const [workingKey] = keys.splice(index, 1);
  keys.unshift(workingKey);
}

export async function fetchText(
  url: string,
  fetchImpl: FetchLike,
  options: { maximumBytes: number; label: string },
): Promise<string> {
  return withTimeout(async (signal) => {
    const response = await fetchImpl(url, { signal });
    const rawText = await readBoundedResponseText(response, {
      label: options.label,
      maximumBytes: options.maximumBytes,
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `요청 실패 (${response.status} ${response.statusText}) ${safePreview(rawText, [])}`,
      );
    }
    return rawText;
  });
}

async function fetchJsonOnce(
  url: string,
  key: string,
  allKeys: string[],
  buildHeaders: (key: string) => Record<string, string>,
  fetchImpl: FetchLike,
  init: RequestInit,
): Promise<JsonRecord> {
  return withTimeout(async (signal) => {
    const response = await fetchImpl(url, {
      ...init,
      headers: mergeHeaders(init.headers, buildHeaders(key)),
      signal,
    });
    const rawText = await readBoundedResponseText(response, {
      label: "Model discovery JSON",
      maximumBytes: MAX_MODEL_DISCOVERY_JSON_BYTES,
      signal,
    });
    assertResponseOk(response, rawText, allKeys);
    return parseJsonRecord(rawText);
  });
}

function assertHasKey(keys: string[], allowMissingKey: boolean): void {
  if (!allowMissingKey && keys.every((key) => !key)) {
    throw new Error("API 키 또는 액세스 토큰을 먼저 입력해 주세요.");
  }
}

function assertResponseOk(
  response: Response,
  rawText: string,
  keys: string[],
): void {
  if (response.ok) {
    return;
  }
  const error = new Error(
    `모델 목록 요청 실패 (${response.status} ${response.statusText}) ${safePreview(rawText, keys)}`,
  );
  if (
    !isRetryableDiscoveryStatus(response.status) &&
    !isApiKeyCredentialFailure(response.status, rawText)
  ) {
    throw markDiscoveryNonRetriable(error);
  }
  throw error;
}

function isApiKeyCredentialFailure(status: number, rawText: string): boolean {
  return (
    status === 400 &&
    /API_KEY_INVALID|Please pass a valid API key|API key (?:is not valid|expired|has been reported as leaked)/i.test(
      rawText,
    )
  );
}

function parseJsonRecord(rawText: string): JsonRecord {
  const parsed = JSON.parse(rawText) as unknown;
  const record = readRecord(parsed);
  if (!record) {
    throw new Error("모델 목록 응답이 JSON 객체가 아닙니다.");
  }
  return record;
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function mergeHeaders(
  initial: HeadersInit | undefined,
  extra: Record<string, string>,
): Headers {
  const headers = new Headers(initial);
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  return headers;
}

function isRetryableDiscoveryStatus(status: number): boolean {
  return [401, 402, 403, 408, 409, 425, 429].includes(status) || status >= 500;
}

function safePreview(value: string, keys: string[]): string {
  let preview = value.replace(/\s+/g, " ").slice(0, 500);
  for (const key of [...keys]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    preview = preview.split(key).join("[redacted-api-key]");
  }
  return preview;
}

type DiscoveryError = Error & { discoveryNonRetriable?: boolean };

function markDiscoveryNonRetriable(error: Error): DiscoveryError {
  return Object.assign(error, { discoveryNonRetriable: true });
}

function isDiscoveryNonRetriable(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "discoveryNonRetriable" in error &&
    (error as DiscoveryError).discoveryNonRetriable,
  );
}

function isResponseBudgetError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "responseBudgetExceeded" in error &&
    (error as { responseBudgetExceeded?: unknown }).responseBudgetExceeded ===
      true,
  );
}
