import { dirname } from "node:path";
import { join } from "node:path";
import { getAppPaths } from "./appPaths";
import { createLoggerRuntime } from "./loggerRuntime";
import { redactDiagnosticText } from "./errorReportRedaction";

const MAX_SERIALIZED_STRING_LENGTH = 16000;
const MAX_SERIALIZED_STACK_LENGTH = 32000;
const MAX_SERIALIZED_ARRAY_ITEMS = 40;
const MAX_SERIALIZED_OBJECT_KEYS = 60;
const MAX_SERIALIZATION_DEPTH = 8;
const SENSITIVE_LOG_KEY =
  /^(?:api[-_]?key|tavilyApiKey|authorization|proxy[-_]?authorization|access[-_]?token|refresh[-_]?token|token|secret|password|cookie|set[-_]?cookie|customHeadersJson|extraBodyJson|promptOverrideText(?:Preview)?|sourceText|translatedText|ocrText|outputPreview|repairedOutputPreview|story|glossary|characters|imagePath|sourcePath|outputPath|outputDir|fileName|filePath|workName|chapterName|pageName)$/i;
const SENSITIVE_LOG_KEY_SUFFIX =
  /(?:^|[-_])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|cookie)$/i;

export type LogLevel = "debug" | "info" | "warn" | "error";
type NormalizedLogValueResult =
  | { handled: true; value: unknown }
  | { handled: false };

const UNHANDLED_LOG_VALUE: NormalizedLogValueResult = { handled: false };

export function getLogPath(): string {
  const configured = process.env.MANGA_TRANSLATOR_LOG_PATH?.trim();
  return configured || getAppPaths().logFile;
}

export function getLogDirectory(): string {
  return dirname(getLogPath());
}

export function logInfo(message: string, detail?: unknown): void {
  writeLog("info", message, detail);
}

export function logWarn(message: string, detail?: unknown): void {
  writeLog("warn", message, detail);
}

export function logError(message: string, detail?: unknown): void {
  writeLog("error", message, detail);
}

export function writeLog(
  level: LogLevel,
  message: string,
  detail?: unknown,
): void {
  loggerRuntime.writeLog(level, message, detail);
}

export function resetAppLog(): void {
  loggerRuntime.resetAppLog();
}

export function getPreviousLogPath(logPath = getLogPath()): string {
  return join(dirname(logPath), "previous.log");
}

export function serializeLogDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return sanitizeLogString(detail).replace(/\r?\n/g, "\\n");
  }

  try {
    return JSON.stringify(normalizeLogValue(detail, new WeakSet<object>(), 0));
  } catch (error) {
    return JSON.stringify({
      type: describeUnknown(detail),
      serializationError:
        error instanceof Error
          ? sanitizeLogString(error.message)
          : "unknown serialization failure",
    });
  }
}

function normalizeLogValue(
  detail: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  const primitive = normalizePrimitiveLogValue(detail);
  if (primitive.handled) {
    return primitive.value;
  }

  const objectValue = detail as object;
  const knownObject = normalizeKnownObjectLogValue(objectValue, seen, depth);
  if (knownObject.handled) {
    return knownObject.value;
  }

  if (depth >= MAX_SERIALIZATION_DEPTH) {
    return `[${describeObject(objectValue)}]`;
  }
  return normalizeObject(objectValue, seen, depth);
}

function normalizePrimitiveLogValue(detail: unknown): NormalizedLogValueResult {
  if (detail === null || detail === undefined) {
    return { handled: true, value: detail };
  }

  if (typeof detail === "string") {
    return { handled: true, value: sanitizeLogString(detail) };
  }

  if (typeof detail === "number" || typeof detail === "boolean") {
    return { handled: true, value: detail };
  }

  if (typeof detail === "bigint") {
    return { handled: true, value: `${detail}n` };
  }

  if (typeof detail === "symbol" || typeof detail === "function") {
    return { handled: true, value: String(detail) };
  }

  return UNHANDLED_LOG_VALUE;
}

function normalizeKnownObjectLogValue(
  detail: object,
  seen: WeakSet<object>,
  depth: number,
): NormalizedLogValueResult {
  if (detail instanceof Error) {
    return { handled: true, value: normalizeError(detail, seen, depth) };
  }

  if (detail instanceof Date) {
    const value = Number.isNaN(detail.getTime())
      ? "Invalid Date"
      : detail.toISOString();
    return { handled: true, value };
  }

  if (detail instanceof URL) {
    return { handled: true, value: sanitizeLogString(detail.toString()) };
  }

  if (Buffer.isBuffer(detail)) {
    return {
      handled: true,
      value: {
        type: "Buffer",
        length: detail.length,
      },
    };
  }

  if (Array.isArray(detail)) {
    return {
      handled: true,
      value:
        depth >= MAX_SERIALIZATION_DEPTH
          ? `[Array(${detail.length})]`
          : normalizeArray(detail, seen, depth),
    };
  }

  if (detail instanceof Map) {
    return {
      handled: true,
      value:
        depth >= MAX_SERIALIZATION_DEPTH
          ? `[Map(${detail.size})]`
          : normalizeMap(detail, seen, depth),
    };
  }

  if (detail instanceof Set) {
    return {
      handled: true,
      value:
        depth >= MAX_SERIALIZATION_DEPTH
          ? `[Set(${detail.size})]`
          : normalizeSet(detail, seen, depth),
    };
  }

  return UNHANDLED_LOG_VALUE;
}

function normalizeMap(
  detail: Map<unknown, unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  return {
    type: "Map",
    size: detail.size,
    entries: Array.from(detail.entries())
      .slice(0, MAX_SERIALIZED_ARRAY_ITEMS)
      .map(([key, value]) => {
        const normalizedKey = normalizeLogValue(key, seen, depth + 1);
        return [
          normalizedKey,
          typeof key === "string" && isSensitiveLogKey(key)
            ? "<redacted>"
            : normalizeLogValue(value, seen, depth + 1),
        ];
      }),
    truncatedEntries: Math.max(detail.size - MAX_SERIALIZED_ARRAY_ITEMS, 0),
  };
}

function normalizeSet(
  detail: Set<unknown>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  return {
    type: "Set",
    size: detail.size,
    values: Array.from(detail.values())
      .slice(0, MAX_SERIALIZED_ARRAY_ITEMS)
      .map((value) => normalizeLogValue(value, seen, depth + 1)),
    truncatedEntries: Math.max(detail.size - MAX_SERIALIZED_ARRAY_ITEMS, 0),
  };
}

function normalizeArray(
  detail: unknown[],
  seen: WeakSet<object>,
  depth: number,
): unknown[] {
  if (seen.has(detail)) {
    return ["[Circular]"];
  }

  seen.add(detail);
  try {
    const values = detail
      .slice(0, MAX_SERIALIZED_ARRAY_ITEMS)
      .map((value) => normalizeLogValue(value, seen, depth + 1));
    if (detail.length > MAX_SERIALIZED_ARRAY_ITEMS) {
      values.push(
        `... ${detail.length - MAX_SERIALIZED_ARRAY_ITEMS} more items`,
      );
    }
    return values;
  } finally {
    seen.delete(detail);
  }
}

function normalizeObject(
  detail: object,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> | string {
  if (seen.has(detail)) {
    return "[Circular]";
  }

  seen.add(detail);
  try {
    const source = detail as Record<string, unknown>;
    const keys = Object.keys(source);
    const limitedKeys = keys.slice(0, MAX_SERIALIZED_OBJECT_KEYS);
    const result: Record<string, unknown> = {};
    const typeName = describeObject(detail);
    if (typeName !== "Object") {
      result.__type = typeName;
    }

    for (const key of limitedKeys) {
      result[key] = isSensitiveLogKey(key)
        ? "<redacted>"
        : normalizeLogValue(source[key], seen, depth + 1);
    }

    if (keys.length > limitedKeys.length) {
      result.__truncatedKeys = keys.length - limitedKeys.length;
    }

    return result;
  } finally {
    seen.delete(detail);
  }
}

function normalizeError(
  detail: Error,
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown> | string {
  if (seen.has(detail)) {
    return "[Circular Error]";
  }

  seen.add(detail);
  try {
    const error = detail as Error & { cause?: unknown };
    const result: Record<string, unknown> = {
      name: sanitizeLogString(error.name),
      message: sanitizeLogString(error.message),
      stack: error.stack
        ? sanitizeLogString(error.stack, MAX_SERIALIZED_STACK_LENGTH)
        : undefined,
    };

    if ("cause" in error && error.cause !== undefined) {
      result.cause = normalizeLogValue(error.cause, seen, depth + 1);
    }

    const ownPropertyNames = Object.getOwnPropertyNames(error);
    for (const key of ownPropertyNames) {
      if (
        key === "name" ||
        key === "message" ||
        key === "stack" ||
        key === "cause"
      ) {
        continue;
      }
      result[key] = isSensitiveLogKey(key)
        ? "<redacted>"
        : normalizeLogValue(Reflect.get(error, key), seen, depth + 1);
    }

    return stripUndefined(result);
  } finally {
    seen.delete(detail);
  }
}

function stripUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function describeObject(detail: object): string {
  return Object.prototype.toString.call(detail).slice(8, -1) || "Object";
}

function describeUnknown(detail: unknown): string {
  return detail && typeof detail === "object"
    ? describeObject(detail)
    : typeof detail;
}

function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_LOG_KEY.test(key) || SENSITIVE_LOG_KEY_SUFFIX.test(key);
}

function limitString(
  value: string,
  maxLength = MAX_SERIALIZED_STRING_LENGTH,
): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}… [truncated ${value.length - maxLength} chars]`;
}

function sanitizeLogString(
  value: string,
  maxLength = MAX_SERIALIZED_STRING_LENGTH,
): string {
  return redactDiagnosticText(limitString(value, maxLength)).text;
}

const loggerRuntime = createLoggerRuntime({
  resolveLogPath: getLogPath,
  sanitizeMessage: sanitizeLogString,
  serializeDetail: serializeLogDetail,
});
