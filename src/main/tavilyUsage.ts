import { createHash } from "node:crypto";
import type { TavilyUsageSnapshot } from "../shared/internetResearchTypes";

const USAGE_CACHE_MS = 60_000;

type JsonRecord = Record<string, unknown>;

type UsageCacheEntry = {
  keyHash: string;
  expiresAt: number;
  value: TavilyUsageSnapshot;
};

type UsageLedger = {
  keyHash: string;
  serverKeyUsed: number | null;
  serverAccountUsed: number | null;
  pendingCredits: number;
};

let usageCache: UsageCacheEntry | null = null;
let usageLedger: UsageLedger | null = null;

export function readCachedTavilyUsage(
  apiKey: string,
): TavilyUsageSnapshot | null {
  const keyHash = hashKey(apiKey);
  return usageCache?.keyHash === keyHash && usageCache.expiresAt > Date.now()
    ? usageCache.value
    : null;
}

export function storeTavilyUsage(
  apiKey: string,
  authoritative: TavilyUsageSnapshot,
): TavilyUsageSnapshot {
  const keyHash = hashKey(apiKey);
  usageLedger = reconcileLedger(keyHash, authoritative, usageLedger);
  const value = addCredits(authoritative, usageLedger.pendingCredits);
  usageCache = {
    keyHash,
    expiresAt: Date.now() + USAGE_CACHE_MS,
    value,
  };
  return value;
}

export function applyObservedTavilyCredits(
  apiKey: string,
  credits: number,
): void {
  if (credits <= 0 || usageCache?.keyHash !== hashKey(apiKey)) return;
  if (!usageLedger || usageLedger.keyHash !== usageCache.keyHash) {
    usageLedger = createLedger(usageCache.keyHash, usageCache.value);
  }
  usageLedger.pendingCredits += credits;
  usageCache.value = addCredits(usageCache.value, credits);
}

export function clearTavilyUsageState(): void {
  usageCache = null;
  usageLedger = null;
}

export function parseTavilyUsage(value: unknown): TavilyUsageSnapshot {
  const record = readRecord(value);
  if (!record) throw invalidUsageResponse();
  const nestedUsage = readRecord(record.usage);
  const payload =
    nestedUsage && looksLikeUsagePayload(nestedUsage) ? nestedUsage : record;
  const key =
    parseKeyUsage(payload.key) ??
    (hasAnyKey(payload, ["usage", "used", "limit", "remaining"])
      ? parseKeyUsage(payload)
      : null);
  const account =
    parseAccountUsage(payload.account) ??
    (hasAnyKey(payload, [
      "current_plan",
      "currentPlan",
      "plan_usage",
      "planUsage",
      "plan_limit",
      "planLimit",
    ])
      ? parseAccountUsage(payload)
      : null);
  if (!key && !account) throw invalidUsageResponse();
  return {
    configured: true,
    key,
    account,
    fetchedAt: new Date().toISOString(),
  };
}

function reconcileLedger(
  keyHash: string,
  usage: TavilyUsageSnapshot,
  current: UsageLedger | null,
): UsageLedger {
  if (!current || current.keyHash !== keyHash)
    return createLedger(keyHash, usage);
  const nextKeyUsed = usage.key?.used ?? null;
  const nextAccountUsed = usage.account?.used ?? null;
  const countersReset =
    decreased(current.serverKeyUsed, nextKeyUsed) ||
    decreased(current.serverAccountUsed, nextAccountUsed);
  const acknowledged = Math.max(
    increase(current.serverKeyUsed, nextKeyUsed),
    increase(current.serverAccountUsed, nextAccountUsed),
  );
  return {
    keyHash,
    serverKeyUsed: nextKeyUsed,
    serverAccountUsed: nextAccountUsed,
    pendingCredits: countersReset
      ? 0
      : Math.max(0, current.pendingCredits - acknowledged),
  };
}

function createLedger(
  keyHash: string,
  usage: TavilyUsageSnapshot,
): UsageLedger {
  return {
    keyHash,
    serverKeyUsed: usage.key?.used ?? null,
    serverAccountUsed: usage.account?.used ?? null,
    pendingCredits: 0,
  };
}

function addCredits(
  usage: TavilyUsageSnapshot,
  credits: number,
): TavilyUsageSnapshot {
  if (credits <= 0) return usage;
  return {
    ...usage,
    key: usage.key
      ? {
          ...usage.key,
          used: usage.key.used + credits,
          remaining: Math.max(0, usage.key.remaining - credits),
          searchUsed: usage.key.searchUsed + credits,
        }
      : null,
    account: usage.account
      ? {
          ...usage.account,
          used: usage.account.used + credits,
          remaining: Math.max(0, usage.account.remaining - credits),
        }
      : null,
    fetchedAt: new Date().toISOString(),
  };
}

function decreased(previous: number | null, next: number | null): boolean {
  return previous !== null && next !== null && next < previous;
}

function increase(previous: number | null, next: number | null): number {
  return previous !== null && next !== null ? Math.max(0, next - previous) : 0;
}

function parseKeyUsage(value: unknown): TavilyUsageSnapshot["key"] {
  const key = readRecord(value);
  if (!key) return null;
  const usage = readUsageNumbers(key, {
    used: [
      "usage",
      "used",
      "plan_usage",
      "planUsage",
      "total_usage",
      "totalUsage",
    ],
    limit: [
      "limit",
      "plan_limit",
      "planLimit",
      "monthly_limit",
      "monthlyLimit",
      "quota",
    ],
    remaining: ["remaining", "remaining_credits", "remainingCredits"],
  });
  if (!usage) return null;
  return {
    ...usage,
    searchUsed:
      readFirstNonNegativeNumber(key, [
        "search_usage",
        "searchUsage",
        "search_used",
        "searchUsed",
      ]) ?? 0,
  };
}

function parseAccountUsage(value: unknown): TavilyUsageSnapshot["account"] {
  const account = readRecord(value);
  if (!account) return null;
  const usage = readUsageNumbers(account, {
    used: ["plan_usage", "planUsage", "usage", "used"],
    limit: ["plan_limit", "planLimit", "limit"],
    remaining: ["remaining", "remaining_credits", "remainingCredits"],
  });
  if (!usage) return null;
  return {
    plan: readFirstString(
      account,
      ["current_plan", "currentPlan", "plan"],
      120,
    ),
    ...usage,
    paygoUsed:
      readFirstNonNegativeNumber(account, ["paygo_usage", "paygoUsage"]) ?? 0,
    paygoLimit:
      readFirstNonNegativeNumber(account, ["paygo_limit", "paygoLimit"]) ?? 0,
  };
}

function readUsageNumbers(
  record: JsonRecord,
  keys: { used: string[]; limit: string[]; remaining: string[] },
): { used: number; limit: number; remaining: number } | null {
  const supplied = {
    used: readFirstNonNegativeNumber(record, keys.used),
    limit: readFirstNonNegativeNumber(record, keys.limit),
    remaining: readFirstNonNegativeNumber(record, keys.remaining),
  };
  return completeUsageNumbers(supplied);
}

function completeUsageNumbers(values: {
  used: number | null;
  limit: number | null;
  remaining: number | null;
}): { used: number; limit: number; remaining: number } | null {
  const used = values.used ?? deriveUsed(values.limit, values.remaining);
  const limit = values.limit ?? deriveLimit(used, values.remaining);
  const remaining = values.remaining ?? deriveRemaining(used, limit);
  return used === null || limit === null || remaining === null
    ? null
    : { used, limit, remaining };
}

function deriveUsed(
  limit: number | null,
  remaining: number | null,
): number | null {
  return limit !== null && remaining !== null
    ? Math.max(0, limit - remaining)
    : null;
}

function deriveLimit(
  used: number | null,
  remaining: number | null,
): number | null {
  return used !== null && remaining !== null ? used + remaining : null;
}

function deriveRemaining(
  used: number | null,
  limit: number | null,
): number | null {
  return used !== null && limit !== null ? Math.max(0, limit - used) : null;
}

function readFirstNonNegativeNumber(
  record: JsonRecord,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = readNonNegativeNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function readFirstString(
  record: JsonRecord,
  keys: readonly string[],
  maxLength: number,
): string {
  for (const key of keys) {
    const value = readString(record[key], maxLength);
    if (value) return value;
  }
  return "";
}

function looksLikeUsagePayload(record: JsonRecord): boolean {
  return hasAnyKey(record, [
    "key",
    "account",
    "used",
    "limit",
    "remaining",
    "plan_usage",
    "planUsage",
  ]);
}

function hasAnyKey(record: JsonRecord, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function invalidUsageResponse(): Error {
  return new Error("Tavily 사용량 응답 형식이 올바르지 않습니다.");
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

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
