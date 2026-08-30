import { useCallback } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  CreateImportResult,
  ImportPreviewSession,
} from "../../../shared/importTypes";
import { libraryGateway as mangaGateway } from "../api/libraryGateway";
import type { ImportModalSubmit } from "../lib/importFlowTypes";
import type {
  ErrorMessageFormatter,
  ImportShareActions,
  UseImportShareActionsOptions,
} from "./importShareActionTypes";
import { finishImportedChapterNavigation } from "./importedChapterNavigation";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";

// eslint-disable-next-line max-lines-per-function -- draft recovery, commit boundary, refresh, and navigation safety form one transaction
export function useSubmitImportAction(
  {
    applyChapter,
    dirty,
    getNavigationKey,
    importPreview,
    openTranslateOptions,
    pushStatus,
    refreshLibrary,
    resetWorkspaceHistory,
    saveNow,
    setImportBusy,
    setImportModalOpen = NOOP_BOOLEAN_DISPATCH,
    setImportDraft = NOOP_IMPORT_DRAFT_DISPATCH,
    setImportFeedback = NOOP_IMPORT_FEEDBACK_DISPATCH,
    setImportPreview,
  }: UseImportShareActionsOptions,
  formatErrorMessage: ErrorMessageFormatter,
): ImportShareActions["submitImport"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (payload: ImportModalSubmit) => {
      if (!importPreview) return;
      const navigationKey = getNavigationKey();
      setImportDraft(payload);
      setImportFeedback(null);
      handoffActiveModalToWorkCenter();
      setImportModalOpen(false);
      setImportBusy(true);
      try {
        let result: CreateImportResult;
        try {
          result = await commitImport(dirty, importPreview, payload, saveNow);
        } catch (error) {
          restoreFailedImport(
            error,
            { pushStatus, setImportFeedback, setImportModalOpen },
            t,
            formatErrorMessage,
          );
          return;
        }
        // A returned result means the transaction committed and the preview
        // was consumed. Later failures must never reopen stale input.
        setImportPreview(null);
        await finishCommittedImport(
          {
            applyChapter,
            openTranslateOptions,
            pushStatus,
            refreshLibrary,
            resetWorkspaceHistory,
            saveNow,
            getNavigationKey,
          },
          importPreview.mode,
          result,
          navigationKey,
          t,
          formatErrorMessage,
        );
      } finally {
        setImportBusy(false);
      }
    },
    [
      applyChapter,
      dirty,
      getNavigationKey,
      importPreview,
      openTranslateOptions,
      pushStatus,
      refreshLibrary,
      resetWorkspaceHistory,
      saveNow,
      setImportBusy,
      setImportDraft,
      setImportFeedback,
      setImportModalOpen,
      setImportPreview,
      t,
      formatErrorMessage,
    ],
  );
}

async function commitImport(
  dirty: boolean,
  preview: ImportPreviewSession,
  { target, selections, linkedWorkspace }: ImportModalSubmit,
  saveNow: () => Promise<void>,
): Promise<CreateImportResult> {
  if (dirty) await saveNow();
  return mangaGateway.createImport({
    previewId: preview.previewId,
    target,
    selections,
    ...(linkedWorkspace ? { linkedWorkspace } : {}),
  });
}

function restoreFailedImport(
  error: unknown,
  actions: Pick<
    UseImportShareActionsOptions,
    "pushStatus" | "setImportFeedback" | "setImportModalOpen"
  >,
  t: TFunction<"renderer">,
  formatErrorMessage: ErrorMessageFormatter,
): void {
  const cancelled = isAbortLike(error);
  const message = formatErrorMessage(
    error,
    t(cancelled ? "import.cancelled" : "import.applyFailed"),
  );
  actions.setImportFeedback?.({
    message,
    variant: cancelled ? "info" : "danger",
  });
  actions.setImportModalOpen?.(true);
  actions.pushStatus(message);
}

async function finishCommittedImport(
  actions: Pick<
    UseImportShareActionsOptions,
    | "applyChapter"
    | "openTranslateOptions"
    | "pushStatus"
    | "refreshLibrary"
    | "resetWorkspaceHistory"
    | "saveNow"
    | "getNavigationKey"
  >,
  mode: ImportPreviewSession["mode"],
  result: CreateImportResult,
  navigationKey: string,
  t: TFunction<"renderer">,
  formatErrorMessage: ErrorMessageFormatter,
): Promise<void> {
  try {
    await actions.refreshLibrary();
  } catch (error) {
    actions.pushStatus(
      formatErrorMessage(error, t("library.refreshAfterJobFailed")),
    );
  }
  await finishImportedChapterNavigation({
    applyChapter: actions.applyChapter,
    chapter: result.openedChapter,
    getNavigationKey: actions.getNavigationKey,
    navigationKey,
    openTranslateOptions: actions.openTranslateOptions,
    openWorkTranslation: mode === "batch",
    pushStatus: actions.pushStatus,
    resetWorkspaceHistory: actions.resetWorkspaceHistory,
    saveNow: actions.saveNow,
    status: t("import.added", { count: result.chapterIds.length }),
  });
  if (result.linkedWorkspaceWarning) {
    actions.pushStatus(result.linkedWorkspaceWarning);
  }
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\bAbortError\b|operation aborted|cancel import/i.test(message);
}

const NOOP_BOOLEAN_DISPATCH: NonNullable<
  UseImportShareActionsOptions["setImportModalOpen"]
> = () => undefined;
const NOOP_IMPORT_DRAFT_DISPATCH: NonNullable<
  UseImportShareActionsOptions["setImportDraft"]
> = () => undefined;
const NOOP_IMPORT_FEEDBACK_DISPATCH: NonNullable<
  UseImportShareActionsOptions["setImportFeedback"]
> = () => undefined;
