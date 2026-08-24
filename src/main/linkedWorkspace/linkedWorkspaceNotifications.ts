type LinkedWorkspaceSaveNotifier = (
  chapterId: string,
  pageIds: readonly string[],
) => Promise<void>;

let notifier: LinkedWorkspaceSaveNotifier | null = null;
let reportError: ((message: string, detail?: unknown) => void) | null = null;

export function installLinkedWorkspaceSaveNotifier(
  nextNotifier: LinkedWorkspaceSaveNotifier,
  nextReportError: (message: string, detail?: unknown) => void,
): () => void {
  notifier = nextNotifier;
  reportError = nextReportError;
  return () => {
    if (notifier === nextNotifier) notifier = null;
    if (reportError === nextReportError) reportError = null;
  };
}

export function notifyLinkedWorkspacePagesSaved(
  chapterId: string,
  pageIds: readonly string[],
): void {
  if (!notifier || pageIds.length === 0) return;
  void notifier(chapterId, pageIds).catch((error: unknown) => {
    reportError?.("Failed to queue linked workspace pages after save", error);
  });
}
