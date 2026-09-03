import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ImportPreviewSession } from "../../../shared/importTypes";
import type {
  WorkShareExportRequest,
  WorkShareImportResult,
} from "../../../shared/shareTypes";
import { formatErrorMessage } from "../lib/errorPresentation";
import type { TranslateSourceMode } from "../lib/importFlowTypes";
import type { ShareImportModalSubmit } from "../lib/shareImportTypes";
import { libraryGateway as mangaGateway } from "../api/libraryGateway";
import type {
  ImportShareActions,
  UseImportShareActionsOptions,
} from "./importShareActionTypes";
import { useSubmitImportAction } from "./useSubmitLibraryImportAction";
import { finishImportedChapterNavigation } from "./importedChapterNavigation";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";

type ImportPreviewMode = Exclude<TranslateSourceMode, "web"> | "zip-folder";

async function requestImportPreview(
  mode: ImportPreviewMode,
): Promise<ImportPreviewSession | null> {
  if (mode === "images") {
    return mangaGateway.previewImagesImport();
  }
  if (mode === "folder") {
    return mangaGateway.previewFolderImport();
  }
  if (mode === "zip") {
    return mangaGateway.previewZipImport();
  }
  if (mode === "pdf") {
    return mangaGateway.previewPdfImport();
  }
  return mangaGateway.previewZipFolderImport();
}

export function useImportShareActions(
  options: UseImportShareActionsOptions,
): ImportShareActions {
  const openImportPreview = useOpenImportPreviewAction(options);
  const selectTranslateSource = useSelectTranslateSourceAction({
    ...options,
    openImportPreview,
  });
  const openShareImportPreview = useOpenShareImportPreviewAction(options);
  const { setImportPreview, setWebImportOpen } = options;
  const acceptWebImportPreview = useCallback(
    (preview: ImportPreviewSession) => {
      setWebImportOpen(false);
      setImportPreview(preview);
    },
    [setImportPreview, setWebImportOpen],
  );
  const cancelImportPreview = useCancelImportPreviewAction(options);
  const submitImport = useSubmitImportAction(options, formatErrorMessage);
  const submitShareExport = useSubmitShareExportAction(options);
  const submitShareImport = useSubmitShareImportAction(options);

  return {
    openImportPreview,
    openShareImportPreview,
    selectTranslateSource,
    acceptWebImportPreview,
    cancelImportPreview,
    submitImport,
    submitShareExport,
    submitShareImport,
  };
}

function useOpenImportPreviewAction({
  pushStatus,
  setImportPreview,
}: UseImportShareActionsOptions): ImportShareActions["openImportPreview"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (mode: ImportPreviewMode) => {
      try {
        const preview = await requestImportPreview(mode);
        if (preview) {
          setImportPreview(preview);
        }
      } catch (error) {
        pushStatus(formatErrorMessage(error, t("import.sourceReadFailed")));
      }
    },
    [pushStatus, setImportPreview, t],
  );
}

function useSelectTranslateSourceAction({
  openImportPreview,
  setWebImportOpen,
}: UseImportShareActionsOptions & {
  openImportPreview: ImportShareActions["openImportPreview"];
}): ImportShareActions["selectTranslateSource"] {
  return useCallback(
    async (mode: TranslateSourceMode) => {
      if (mode === "web") {
        setWebImportOpen(true);
        return;
      }
      await openImportPreview(mode);
    },
    [openImportPreview, setWebImportOpen],
  );
}

function useCancelImportPreviewAction({
  importPreview,
  pushStatus,
  setImportPreview,
}: UseImportShareActionsOptions): ImportShareActions["cancelImportPreview"] {
  const { t } = useTranslation("renderer");
  return useCallback(async () => {
    const previewId = importPreview?.previewId;
    setImportPreview(null);
    if (!previewId) return;
    try {
      await mangaGateway.discardImportPreview(previewId);
    } catch (error) {
      pushStatus(formatErrorMessage(error, t("import.previewDiscardFailed")));
    }
  }, [importPreview?.previewId, pushStatus, setImportPreview, t]);
}

function useSubmitShareExportAction({
  dirty,
  pushStatus,
  saveNow,
  setShareExportBusy,
  setShareExportDraft,
  setShareExportOpen,
}: UseImportShareActionsOptions): ImportShareActions["submitShareExport"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (request: WorkShareExportRequest) => {
      setShareExportDraft(request);
      handoffActiveModalToWorkCenter();
      setShareExportOpen(false);
      setShareExportBusy(true);
      try {
        if (dirty) {
          await saveNow();
        }
        const result = await mangaGateway.exportWorkShare(request);
        if (result) {
          pushStatus(
            t("share.exportSuccess", {
              title: result.workTitle,
              chapters: result.chapterCount,
              pages: result.pageCount,
            }),
          );
          setShareExportDraft(null);
        } else {
          setShareExportOpen(true);
        }
      } catch (error) {
        pushStatus(formatErrorMessage(error, t("share.exportFailed")));
        setShareExportOpen(true);
      } finally {
        setShareExportBusy(false);
      }
    },
    [
      dirty,
      pushStatus,
      saveNow,
      setShareExportBusy,
      setShareExportDraft,
      setShareExportOpen,
      t,
    ],
  );
}

function useOpenShareImportPreviewAction({
  dirty,
  pushStatus,
  saveNow,
  setShareImportPreview,
}: UseImportShareActionsOptions): ImportShareActions["openShareImportPreview"] {
  const { t } = useTranslation("renderer");
  return useCallback(async () => {
    try {
      if (dirty) {
        await saveNow();
      }
      const preview = await mangaGateway.previewWorkShareImport();
      if (preview) {
        setShareImportPreview(preview);
      }
    } catch (error) {
      pushStatus(formatErrorMessage(error, t("share.readFailed")));
    }
  }, [dirty, pushStatus, saveNow, setShareImportPreview, t]);
}

// eslint-disable-next-line max-lines-per-function -- confirmation, commit boundary, recovery, refresh, and navigation safety form one transaction
function useSubmitShareImportAction({
  applyChapter,
  askConfirm,
  dirty,
  getNavigationKey,
  openTranslateOptions,
  pushStatus,
  refreshLibrary,
  resetWorkspaceHistory,
  saveNow,
  setShareImportBusy,
  setShareImportDraft,
  setShareImportPreview,
  shareImportPreview,
}: UseImportShareActionsOptions): ImportShareActions["submitShareImport"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (payload: ShareImportModalSubmit) => {
      if (!shareImportPreview) {
        return;
      }

      if (!(await confirmShareImportChanges(payload, askConfirm, t))) return;

      const activePreview = shareImportPreview;
      const navigationKey = getNavigationKey();
      setShareImportDraft(payload);
      handoffActiveModalToWorkCenter();
      setShareImportPreview(null);
      setShareImportBusy(true);
      try {
        let result: WorkShareImportResult;
        try {
          if (dirty) {
            await saveNow();
          }
          result = await mangaGateway.importWorkShare({
            previewId: activePreview.previewId,
            target: payload.target,
            entries: payload.entries,
          });
        } catch (error) {
          pushStatus(formatErrorMessage(error, t("share.importFailed")));
          setShareImportPreview(activePreview);
          return;
        }
        setShareImportDraft(null);
        try {
          await refreshLibrary();
        } catch (error) {
          pushStatus(
            formatErrorMessage(error, t("library.refreshAfterJobFailed")),
          );
        }
        await finishImportedChapterNavigation({
          applyChapter,
          chapter: result.openedChapter,
          getNavigationKey,
          navigationKey,
          openTranslateOptions,
          openWorkTranslation: false,
          pushStatus,
          resetWorkspaceHistory,
          saveNow,
          status: t("share.importApplied", { count: result.chapterIds.length }),
        });
      } finally {
        setShareImportBusy(false);
      }
    },
    [
      applyChapter,
      askConfirm,
      dirty,
      getNavigationKey,
      openTranslateOptions,
      pushStatus,
      refreshLibrary,
      resetWorkspaceHistory,
      saveNow,
      setShareImportBusy,
      setShareImportDraft,
      setShareImportPreview,
      shareImportPreview,
      t,
    ],
  );
}

async function confirmShareImportChanges(
  payload: ShareImportModalSubmit,
  askConfirm: UseImportShareActionsOptions["askConfirm"],
  t: TFunction<"renderer">,
): Promise<boolean> {
  if (payload.remainingPackageChapters.length > 0) {
    const confirmed = await askConfirm(
      t("share.remainingChaptersTitle"),
      t("share.remainingChaptersMessage"),
      payload.remainingPackageChapters
        .map((chapter) => chapter.title)
        .join("\n"),
    );
    if (!confirmed) return false;
  }
  if (payload.deletedExistingChapters.length === 0) return true;
  return askConfirm(
    t("share.deleteExistingTitle"),
    t("share.deleteExistingMessage"),
    payload.deletedExistingChapters.map((chapter) => chapter.title).join("\n"),
  );
}
