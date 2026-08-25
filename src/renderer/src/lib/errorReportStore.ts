import { useSyncExternalStore } from "react";
import type { ErrorReportContext } from "../../../shared/errorReportTypes";
import { errorReportGateway } from "./errorReportGateway";

const DUPLICATE_WINDOW_MS = 30_000;
const MAX_RECENT_FINGERPRINTS = 128;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_STACK_LENGTH = 16_000;

const MAX_QUEUED_INCIDENTS = 4;

let currentIncident: ErrorReportContext | null = null;
let initialized = false;
const listeners = new Set<() => void>();
const recentFingerprints = new Map<string, number>();
/**
 * Incidents that arrived while a report was already on screen. Only one dialog
 * can be shown at a time, but dropping the rest would lose the very failures a
 * user is most likely to be chasing, so they wait here and surface as the
 * current report is dismissed.
 */
const queuedIncidents: ErrorReportContext[] = [];

export function getErrorReportIncident(): ErrorReportContext | null {
  return currentIncident;
}

export function useErrorReportIncident(): ErrorReportContext | null {
  return useSyncExternalStore(
    subscribeToErrorReportIncidents,
    getErrorReportIncident,
    getErrorReportIncident,
  );
}

export function openErrorReport(
  context: ErrorReportContext,
  options: { force?: boolean } = {},
): boolean {
  const normalized = normalizeContext(context);
  const now = Date.now();
  if (!options.force && isRecentDuplicate(normalized, now)) {
    return false;
  }
  if (currentIncident) {
    enqueueIncident(normalized);
    return false;
  }
  currentIncident = normalized;
  emitChange();
  return true;
}

export function openManualErrorReport(): boolean {
  return openErrorReport({ source: "manual" }, { force: true });
}

export function closeErrorReport(): void {
  if (!currentIncident) {
    return;
  }
  currentIncident = queuedIncidents.shift() ?? null;
  emitChange();
}

function isRecentDuplicate(context: ErrorReportContext, now: number): boolean {
  pruneOldFingerprints(now);
  const fingerprint = createFingerprint(context);
  const previous = recentFingerprints.get(fingerprint);
  if (previous !== undefined && now - previous < DUPLICATE_WINDOW_MS) {
    return true;
  }
  evictOldestFingerprints();
  recentFingerprints.set(fingerprint, now);
  return false;
}

function enqueueIncident(context: ErrorReportContext): void {
  const fingerprint = createFingerprint(context);
  if (createFingerprint(currentIncident ?? context) === fingerprint) {
    return;
  }
  if (
    queuedIncidents.some((queued) => createFingerprint(queued) === fingerprint)
  ) {
    return;
  }
  if (queuedIncidents.length >= MAX_QUEUED_INCIDENTS) {
    // Keep the oldest queued failures: they are closest to the root cause.
    return;
  }
  queuedIncidents.push(context);
}

export function initializeGlobalErrorReporting(): void {
  if (initialized || typeof window === "undefined") {
    return;
  }
  initialized = true;

  window.addEventListener("error", (event) => {
    const error = normalizeUnknownError(event.error ?? event.message);
    void errorReportGateway
      .writeLog("error", "렌더러 전역 오류", error)
      .catch(console.error);
    openErrorReport({
      source: "renderer-global",
      summary: error.message,
      message: error.message,
      stack: error.stack,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const error = normalizeUnknownError(event.reason);
    void errorReportGateway
      .writeLog("error", "렌더러 처리되지 않은 Promise 오류", error)
      .catch(console.error);
    openErrorReport({
      source: "renderer-global",
      summary: error.message,
      message: error.message,
      stack: error.stack,
    });
  });

  errorReportGateway.onErrorIncident((context) => {
    openErrorReport(context);
  });
}

export function resetErrorReportStoreForTests(): void {
  currentIncident = null;
  queuedIncidents.length = 0;
  recentFingerprints.clear();
  emitChange();
}

function subscribeToErrorReportIncidents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function normalizeContext(context: ErrorReportContext): ErrorReportContext {
  return {
    source: context.source,
    ...(context.summary
      ? { summary: limitText(context.summary, MAX_MESSAGE_LENGTH) }
      : {}),
    ...(context.message
      ? { message: limitText(context.message, MAX_MESSAGE_LENGTH) }
      : {}),
    ...(context.stack
      ? { stack: limitText(context.stack, MAX_STACK_LENGTH) }
      : {}),
    ...(context.componentStack
      ? {
          componentStack: limitText(context.componentStack, MAX_STACK_LENGTH),
        }
      : {}),
    ...(context.jobStage
      ? { jobStage: limitText(context.jobStage, MAX_MESSAGE_LENGTH) }
      : {}),
  };
}

function normalizeUnknownError(value: unknown): {
  message: string;
  stack?: string;
} {
  if (value instanceof Error) {
    return {
      message: limitText(value.message || value.name, MAX_MESSAGE_LENGTH),
      ...(value.stack
        ? { stack: limitText(value.stack, MAX_STACK_LENGTH) }
        : {}),
    };
  }
  if (typeof value === "string") {
    return { message: limitText(value, MAX_MESSAGE_LENGTH) };
  }
  try {
    return {
      message: limitText(JSON.stringify(value), MAX_MESSAGE_LENGTH),
    };
  } catch (_error) {
    return { message: limitText(String(value), MAX_MESSAGE_LENGTH) };
  }
}

function createFingerprint(context: ErrorReportContext): string {
  return [
    context.source,
    context.summary ?? "",
    context.message ?? "",
    context.stack?.split(/\r?\n/, 2).join("\n") ?? "",
    context.jobStage ?? "",
  ].join("\u241f");
}

function pruneOldFingerprints(now: number): void {
  for (const [fingerprint, timestamp] of recentFingerprints) {
    if (now - timestamp >= DUPLICATE_WINDOW_MS) {
      recentFingerprints.delete(fingerprint);
    }
  }
}

function evictOldestFingerprints(): void {
  while (recentFingerprints.size >= MAX_RECENT_FINGERPRINTS) {
    const oldest = recentFingerprints.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    recentFingerprints.delete(oldest);
  }
}

function limitText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
