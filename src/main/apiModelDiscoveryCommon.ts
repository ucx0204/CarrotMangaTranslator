import { MAX_API_KEYS, parseApiKeys } from "../shared/apiKeySettings";
import type {
  ApiModelDiscoveryResult,
  ApiModelOption,
} from "../shared/apiProviderPresets";

export const DISCOVERY_TIMEOUT_MS = 15_000;
export const GOOGLE_PROBE_CONCURRENCY = 6;
export const MAX_GOOGLE_PROBE_CANDIDATES = 200;
const MAX_DISCOVERED_MODELS = 2000;

export type FetchLike = typeof fetch;
export type JsonRecord = Record<string, unknown>;

export function requireApiKeys(
  rawKeys: string,
  providerName: string,
): string[] {
  const keys = parseApiKeys(rawKeys);
  if (keys.length === 0) {
    throw new Error(`${providerName} 인증 정보를 먼저 입력해 주세요.`);
  }
  if (keys.length > MAX_API_KEYS) {
    throw new Error(`API 키는 최대 ${MAX_API_KEYS}개까지 사용할 수 있습니다.`);
  }
  return keys;
}

export function bearerHeaders(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function discoveryResult(
  provider: ApiModelDiscoveryResult["provider"],
  models: ApiModelOption[],
  checkedCount: number,
  unverifiedCount: number,
): ApiModelDiscoveryResult {
  const uniqueModels = new Map(
    models
      .map(sanitizeModelOption)
      .filter((model): model is ApiModelOption => !!model)
      .map((model) => [model.id, model]),
  );
  return {
    provider,
    models: [...uniqueModels.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .slice(0, MAX_DISCOVERED_MODELS),
    checkedCount,
    unverifiedCount,
  };
}

export function modelOption(
  id: string,
  label: string,
  baseUrl: string,
): ApiModelOption {
  return { id, label, baseUrl };
}

function sanitizeModelOption(model: ApiModelOption): ApiModelOption | null {
  const id = model.id.trim().slice(0, 300);
  const label = model.label.trim().slice(0, 500);
  return id && label ? { ...model, id, label } : null;
}

export function isExpired(expirationDate: string | null): boolean {
  if (!expirationDate) {
    return false;
  }
  const timestamp = Date.parse(expirationDate);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}

export function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function recordOrEmpty(value: unknown): JsonRecord[] {
  const record = readRecord(value);
  return record ? [record] : [];
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readStringArray(value: unknown): string[] {
  return readArray(value)
    .map(readString)
    .filter((item): item is string => !!item);
}
