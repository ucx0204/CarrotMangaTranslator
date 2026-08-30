import type {
  AppOperationKind,
  AppOperationPhase,
  AppOperationStatus,
} from "../../../shared/appOperationTypes";
import {
  APP_OPERATION_KINDS,
  APP_OPERATION_PHASES,
  APP_OPERATION_STATUSES,
} from "../../../shared/appOperationTypes";
import type { JobKind, JobStatus } from "../../../shared/jobContracts";
import { JobKindSchema, JobStatusSchema } from "../../../shared/jobContracts";
import type { ImportSourceKind } from "../../../shared/libraryTypes";

export const STATUS_CENTER_HISTORY_LIMIT = 8;
const STORAGE_KEY = "mangaTranslator.statusCenter.history.v1";

export type StatusCenterHistoryEntry = {
  id: string;
  source: "job" | "operation";
  kind: JobKind | AppOperationKind;
  status: JobStatus | AppOperationStatus;
  completedAt: number;
  pageTotal?: number;
  failureCode?: string;
  phase?: AppOperationPhase;
  sourceKind?: ImportSourceKind;
  /** Session-only copy. It is deliberately omitted from persisted data. */
  progressText?: string;
};

export function loadStatusCenterHistory(): StatusCenterHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(parseEntry).slice(0, STATUS_CENTER_HISTORY_LIMIT);
  } catch (_error) {
    return [];
  }
}

export function saveStatusCenterHistory(
  entries: readonly StatusCenterHistoryEntry[],
): void {
  try {
    const sanitized = entries
      .slice(0, STATUS_CENTER_HISTORY_LIMIT)
      .map(
        ({
          id,
          source,
          kind,
          status,
          completedAt,
          pageTotal,
          failureCode,
          phase,
          sourceKind,
        }) => ({
          id: id.slice(0, 240),
          source,
          kind,
          status,
          completedAt,
          ...(pageTotal !== undefined ? { pageTotal } : {}),
          ...(failureCode ? { failureCode } : {}),
          ...(source === "operation" && phase ? { phase } : {}),
          ...(source === "operation" && sourceKind ? { sourceKind } : {}),
        }),
      );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch (_error) {
    // error-policy-allow: storage may be unavailable in hardened or ephemeral renderer sessions.
  }
}

export function clearStatusCenterHistory(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (_error) {
    // error-policy-allow: clearing in-memory history remains useful when storage is blocked.
  }
}

function parseEntry(value: unknown): StatusCenterHistoryEntry[] {
  if (!value || typeof value !== "object") return [];
  const entry = value as Record<string, unknown>;
  const identity = parseEntryIdentity(entry);
  if (!identity) return [];
  const pageTotal = parsePageTotal(entry.pageTotal);
  const failureCode = parseFailureCode(entry.failureCode);
  const phase = parseOperationPhase(identity.source, identity.id, entry.phase);
  const sourceKind = parseOperationSourceKind(
    identity.source,
    entry.sourceKind,
  );
  return [
    {
      ...identity,
      ...(pageTotal !== undefined ? { pageTotal } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(phase ? { phase } : {}),
      ...(sourceKind ? { sourceKind } : {}),
    },
  ];
}

function parseEntryIdentity(
  entry: Record<string, unknown>,
): Pick<
  StatusCenterHistoryEntry,
  "id" | "source" | "kind" | "status" | "completedAt"
> | null {
  const source = parseSource(entry.source);
  if (
    typeof entry.id !== "string" ||
    !source ||
    typeof entry.completedAt !== "number" ||
    !Number.isFinite(entry.completedAt)
  ) {
    return null;
  }
  const kind = parseHistoryKind(source, entry.kind);
  const status = parseHistoryStatus(source, entry.status);
  if (!kind || !status) return null;
  return {
    id: entry.id.slice(0, 240),
    source,
    kind,
    status,
    completedAt: entry.completedAt,
  };
}

function parseSource(
  value: unknown,
): StatusCenterHistoryEntry["source"] | null {
  return value === "job" || value === "operation" ? value : null;
}

function parseHistoryKind(
  source: StatusCenterHistoryEntry["source"],
  value: unknown,
): StatusCenterHistoryEntry["kind"] | null {
  if (source === "job") {
    const result = JobKindSchema.safeParse(value);
    return result.success ? result.data : null;
  }
  if (typeof value !== "string") return null;
  return APP_OPERATION_KINDS.find((kind) => kind === value) ?? null;
}

function parseHistoryStatus(
  source: StatusCenterHistoryEntry["source"],
  value: unknown,
): StatusCenterHistoryEntry["status"] | null {
  if (source === "job") {
    const result = JobStatusSchema.safeParse(value);
    return result.success ? result.data : null;
  }
  if (typeof value !== "string") return null;
  return APP_OPERATION_STATUSES.find((status) => status === value) ?? null;
}

function parsePageTotal(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function parseFailureCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9_-]{1,80}$/.test(value)
    ? value
    : undefined;
}

function parseOperationPhase(
  source: StatusCenterHistoryEntry["source"],
  id: string,
  value: unknown,
): AppOperationPhase | undefined {
  if (source !== "operation") return undefined;
  if (typeof value === "string") {
    const phase = APP_OPERATION_PHASES.find((candidate) => candidate === value);
    if (phase) return phase;
  }
  if (id.startsWith("web-import-prepare-")) return "web-preparing";
  if (id.startsWith("web-import-preview-")) return "web-discovering";
  return undefined;
}

const IMPORT_SOURCE_KINDS: readonly ImportSourceKind[] = [
  "images",
  "folder",
  "zip",
  "rar",
  "pdf",
  "zip-folder",
];

function parseOperationSourceKind(
  source: StatusCenterHistoryEntry["source"],
  value: unknown,
): ImportSourceKind | undefined {
  if (source !== "operation" || typeof value !== "string") return undefined;
  return IMPORT_SOURCE_KINDS.find((candidate) => candidate === value);
}
