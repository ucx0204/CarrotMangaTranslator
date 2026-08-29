import type { TavilyUsageSnapshot } from "../shared/internetResearchTypes";
import {
  createLinkedDeadlineController,
  readBoundedResponseText,
} from "./httpResponseBudget";
import {
  applyObservedTavilyCredits,
  clearTavilyUsageState,
  parseTavilyUsage,
  readCachedTavilyUsage,
  storeTavilyUsage,
} from "./tavilyUsage";

const TAVILY_USAGE_URL = "https://api.tavily.com/usage";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_USAGE_RESPONSE_BYTES = 128 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_QUERY_CHARS = 400;
const MAX_SEARCH_RESULTS = 5;
const MIN_RESULT_SCORE = 0.5;

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
};

export type TavilySearchResponse = {
  query: string;
  results: TavilySearchResult[];
  credits: number;
};

export type TavilySearchOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  exactMatch?: boolean;
};

export async function getTavilyUsage(
  apiKey: string | undefined,
  options: {
    force?: boolean;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
  } = {},
): Promise<TavilyUsageSnapshot> {
  const key = requireApiKey(apiKey);
  const cached = options.force ? null : readCachedTavilyUsage(key);
  if (cached) return cached;
  const response = await requestJson(
    TAVILY_USAGE_URL,
    {
      method: "GET",
      headers: authorizationHeaders(key),
    },
    {
      fetchImpl: options.fetchImpl ?? fetch,
      label: "Tavily usage",
      maximumBytes: MAX_USAGE_RESPONSE_BYTES,
      signal: options.signal,
      retries: 1,
    },
  );
  return storeTavilyUsage(key, parseTavilyUsage(response));
}

export async function searchTavily(
  apiKey: string | undefined,
  query: string,
  options: TavilySearchOptions = {},
): Promise<TavilySearchResponse> {
  const key = requireApiKey(apiKey);
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  if (!normalizedQuery || normalizedQuery.length > MAX_SEARCH_QUERY_CHARS) {
    throw new Error("Tavily 검색어는 1~400자여야 합니다.");
  }
  const response = await requestJson(
    TAVILY_SEARCH_URL,
    {
      method: "POST",
      headers: {
        ...authorizationHeaders(key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: normalizedQuery,
        topic: "general",
        search_depth: "basic",
        auto_parameters: false,
        max_results: MAX_SEARCH_RESULTS,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_favicon: false,
        include_usage: true,
        safe_search: true,
        ...(options.exactMatch ? { exact_match: true } : {}),
      }),
    },
    {
      fetchImpl: options.fetchImpl ?? fetch,
      label: "Tavily search",
      maximumBytes: MAX_SEARCH_RESPONSE_BYTES,
      signal: options.signal,
      retries: 2,
    },
  );
  const parsed = parseTavilySearch(response, normalizedQuery);
  applyObservedTavilyCredits(key, parsed.credits);
  return parsed;
}

export function clearTavilyUsageCache(): void {
  clearTavilyUsageState();
}

export function parseTavilySearch(
  value: unknown,
  fallbackQuery = "",
): TavilySearchResponse {
  const record = readRecord(value);
  const usage = readRecord(record?.usage);
  const credits = readNonNegativeNumber(usage?.credits);
  if (!record || !Array.isArray(record.results) || credits === null) {
    throw new Error("Tavily 검색 응답 형식이 올바르지 않습니다.");
  }
  const results = record.results.flatMap((item) => {
    const result = readRecord(item);
    const title = readString(result?.title, 500);
    const url = readHttpsUrl(result?.url);
    const content = readString(result?.content, 4_000);
    const score = readNonNegativeNumber(result?.score);
    if (
      !title ||
      !url ||
      !content ||
      score === null ||
      score < MIN_RESULT_SCORE
    ) {
      return [];
    }
    return [{ title, url, content, score }];
  });
  return {
    query: readString(record.query, MAX_SEARCH_QUERY_CHARS) || fallbackQuery,
    results: results.slice(0, MAX_SEARCH_RESULTS),
    credits,
  };
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: {
    fetchImpl: FetchLike;
    label: string;
    maximumBytes: number;
    signal?: AbortSignal;
    retries: number;
  },
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await requestJsonOnce(url, init, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableTavilyError(error) || attempt >= options.retries) break;
      await waitForRetry(readRetryDelayMs(error, attempt), options.signal);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${options.label} 요청에 실패했습니다.`);
}

async function requestJsonOnce(
  url: string,
  init: RequestInit,
  options: {
    fetchImpl: FetchLike;
    label: string;
    maximumBytes: number;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const deadline = createLinkedDeadlineController(
    options.signal,
    REQUEST_TIMEOUT_MS,
    options.label,
  );
  try {
    const response = await options.fetchImpl(url, {
      ...init,
      signal: deadline.signal,
    });
    const text = await readBoundedResponseText(response, {
      label: `${options.label} JSON`,
      maximumBytes: options.maximumBytes,
      signal: deadline.signal,
    });
    if (!response.ok) {
      throw makeTavilyHttpError(response, text);
    }
    const parsed = JSON.parse(text) as unknown;
    if (!readRecord(parsed)) {
      throw new Error(`${options.label} 응답이 JSON 객체가 아닙니다.`);
    }
    return parsed;
  } finally {
    deadline.cleanup();
  }
}

type TavilyHttpError = Error & {
  httpStatus: number;
  retryAfterMs?: number;
};

function makeTavilyHttpError(
  response: Response,
  body: string,
): TavilyHttpError {
  const detail = readTavilyErrorDetail(body);
  const error = new Error(
    response.status === 401
      ? "Tavily API 키가 올바르지 않습니다."
      : response.status === 429
        ? "Tavily 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."
        : response.status === 432
          ? `Tavily 플랜 크레딧 한도에 도달했습니다.${detail ? ` ${detail}` : ""}`
          : response.status === 433
            ? `Tavily PAYGO 크레딧 한도에 도달했습니다.${detail ? ` ${detail}` : ""}`
            : `Tavily 요청이 실패했습니다. (${response.status})${detail ? ` ${detail}` : ""}`,
  ) as TavilyHttpError;
  error.httpStatus = response.status;
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
  return error;
}

function readTavilyErrorDetail(body: string): string {
  try {
    const parsed = readRecord(JSON.parse(body));
    if (!parsed) return "";
    const detail = readRecord(parsed.detail);
    const candidate =
      (typeof detail?.error === "string" ? detail.error : null) ??
      (typeof parsed.detail === "string" ? parsed.detail : null) ??
      (typeof parsed.error === "string" ? parsed.error : null);
    return candidate?.replace(/\s+/g, " ").slice(0, 240) ?? "";
  } catch (_error) {
    return "";
  }
}

function isRetryableTavilyError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError")
    return false;
  const status = (error as Partial<TavilyHttpError> | null)?.httpStatus;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function readRetryDelayMs(error: unknown, attempt: number): number {
  const provided = (error as Partial<TavilyHttpError> | null)?.retryAfterMs;
  return Math.min(5_000, provided ?? 500 * 2 ** attempt);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function requireApiKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key) throw new Error("Tavily API 키를 먼저 입력해 주세요.");
  return key;
}

function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function readHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch (_error) {
    return "";
  }
}
