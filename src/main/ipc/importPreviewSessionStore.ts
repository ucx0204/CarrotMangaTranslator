import { randomUUID } from "node:crypto";
import type {
  ImportPreviewResult,
  ImportPreviewSession,
} from "../../shared/importTypes";
import type { RecentDialogLocation } from "../recentDialogPaths";
import { tMain } from "./localization";
import { prunePreviewSessions } from "./previewSessions";

export type StoredImportPreviewSession = {
  preview: ImportPreviewResult;
  recentLocation?: RecentDialogLocation;
  cleanup?: () => Promise<void>;
  createdAt: number;
};

const importPreviewSessions = new Map<string, StoredImportPreviewSession>();

export async function createImportPreviewSession(
  preview: ImportPreviewResult,
  recentLocation?: RecentDialogLocation,
  options: {
    cleanup?: () => Promise<void>;
    redactSourcePaths?: boolean;
  } = {},
): Promise<ImportPreviewSession> {
  await pruneImportPreviewSessions();
  const previewId = randomUUID();
  importPreviewSessions.set(previewId, {
    preview,
    recentLocation,
    createdAt: Date.now(),
    cleanup: options.cleanup,
  });
  return {
    previewId,
    ...(options.redactSourcePaths
      ? redactImportPreviewPaths(preview)
      : preview),
  };
}

export async function getImportPreviewSession(
  previewId: string,
): Promise<StoredImportPreviewSession> {
  await pruneImportPreviewSessions();
  const session = importPreviewSessions.get(previewId);
  if (!session) {
    throw new Error(tMain("ipc.errors.invalidImportPreview"));
  }
  return session;
}

export function removeImportPreviewSession(
  previewId: string,
): StoredImportPreviewSession | undefined {
  const session = importPreviewSessions.get(previewId);
  importPreviewSessions.delete(previewId);
  return session;
}

export async function discardImportPreviewSession(
  previewId: string,
): Promise<boolean> {
  const session = removeImportPreviewSession(previewId);
  if (!session) return false;
  await runImportPreviewCleanup(session.cleanup);
  return true;
}

export async function disposeImportPreviewSessions(): Promise<void> {
  const sessions = [...importPreviewSessions.values()];
  importPreviewSessions.clear();
  const results = await Promise.allSettled(
    sessions.map((session) => runImportPreviewCleanup(session.cleanup)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Import preview cleanup failed.");
  }
}

export async function runImportPreviewCleanup(
  cleanup: (() => Promise<void>) | undefined,
): Promise<void> {
  if (cleanup) await cleanup();
}

async function pruneImportPreviewSessions(): Promise<void> {
  const before = new Map(importPreviewSessions);
  prunePreviewSessions(importPreviewSessions);
  const removed = [...before].flatMap(([id, session]) =>
    importPreviewSessions.has(id) ? [] : [session],
  );
  await Promise.all(
    removed.map((session) => runImportPreviewCleanup(session.cleanup)),
  );
}

function redactImportPreviewPaths(
  preview: ImportPreviewResult,
): ImportPreviewResult {
  return {
    ...preview,
    chapters: preview.chapters.map((chapter) => ({
      ...chapter,
      pages: chapter.pages.map((page, index) => ({
        ...page,
        sourcePath: `web-import-staged://${index + 1}`,
      })),
    })),
  };
}
