import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { ImportPreviewSession } from "../../../shared/importTypes";
import type {
  WorkShareExportRequest,
  WorkShareImportPreview,
} from "../../../shared/shareTypes";
import { formatErrorMessage } from "../lib/errorPresentation";
import type {
  ImportModalSubmit,
  TranslateSourceMode,
} from "../lib/importFlowTypes";
import type { ShareImportModalSubmit } from "../lib/shareImportTypes";
import type { TranslationOptionsInitialScope } from "../lib/translationSelection";
import { libraryGateway as mangaGateway } from "../api/libraryGateway";

type ImportPreviewMode = Exclude<TranslateSourceMode, "web"> | "zip-folder";

type UseImportShareActionsOptions = {
  applyChapter: (
    chapter: ChapterSnapshot | undefined,
    fallbackStatus?: string,
  ) => void;
  askConfirm: (
    title: string,
    message: string,
    detail?: string,
  ) => Promise<boolean>;
  dirty: boolean;
  importPreview: ImportPreviewSession | null;
  openTranslateOptions: (initialScope?: TranslationOptionsInitialScope) => void;
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  resetWorkspaceHistory: () => void;
  saveNow: () => Promise<void>;
  setImportBusy: Dispatch<SetStateAction<boolean>>;
  setImportPreview: Dispatch<SetStateAction<ImportPreviewSession | null>>;
  setShareExportBusy: Dispatch<SetStateAction<boolean>>;
  setShareExportOpen: Dispatch<SetStateAction<boolean>>;
  setShareImportBusy: Dispatch<SetStateAction<boolean>>;
  setShareImportPreview: Dispatch<
    SetStateAction<WorkShareImportPreview | null>
  >;
  setTranslationSourceOpen: Dispatch<SetStateAction<boolean>>;
  setWebImportOpen: Dispatch<SetStateAction<boolean>>;
  shareImportPreview: WorkShareImportPreview | null;
};

type ImportShareActions = {
  openImportPreview: (mode: ImportPreviewMode) => Promise<void>;
  openShareImportPreview: () => Promise<void>;
  selectTranslateSource: (mode: TranslateSourceMode) => Promise<void>;
  acceptWebImportPreview: (preview: ImportPreviewSession) => void;
  cancelImportPreview: () => Promise<void>;
  submitImport: (payload: ImportModalSubmit) => Promise<void>;
  submitShareExport: (request: WorkShareExportRequest) => Promise<void>;
  submitShareImport: (payload: ShareImportModalSubmit) => Promise<void>;
};

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
  const submitImport = useSubmitImportAction(options);
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
        console.error(error);
        pushStatus(formatErrorMessage(error, t("import.sourceReadFailed")));
      }
    },
    [pushStatus, setImportPreview, t],
  );
}

function useSelectTranslateSourceAction({
  openImportPreview,
  setTranslationSourceOpen,
  setWebImportOpen,
}: UseImportShareActionsOptions & {
  openImportPreview: ImportShareActions["openImportPreview"];
}): ImportShareActions["selectTranslateSource"] {
  return useCallback(
    async (mode: TranslateSourceMode) => {
      setTranslationSourceOpen(false);
      if (mode === "web") {
        setWebImportOpen(true);
        return;
      }
      await openImportPreview(mode);
    },
    [openImportPreview, setTranslationSourceOpen, setWebImportOpen],
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
      console.error(error);
      pushStatus(formatErrorMessage(error, t("import.previewDiscardFailed")));
    }
  }, [importPreview?.previewId, pushStatus, setImportPreview, t]);
}

function useSubmitShareExportAction({
  dirty,
  pushStatus,
  saveNow,
  setShareExportBusy,
  setShareExportOpen,
}: UseImportShareActionsOptions): ImportShareActions["submitShareExport"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (request: WorkShareExportRequest) => {
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
          setShareExportOpen(false);
        }
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, t("share.exportFailed")));
      } finally {
        setShareExportBusy(false);
      }
    },
    [dirty, pushStatus, saveNow, setShareExportBusy, setShareExportOpen, t],
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
      console.error(error);
      pushStatus(formatErrorMessage(error, t("share.readFailed")));
    }
  }, [dirty, pushStatus, saveNow, setShareImportPreview, t]);
}

function useSubmitShareImportAction({
  applyChapter,
  askConfirm,
  dirty,
  pushStatus,
  refreshLibrary,
  resetWorkspaceHistory,
  saveNow,
  setShareImportBusy,
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

      setShareImportBusy(true);
      try {
        if (dirty) {
          await saveNow();
        }
        const result = await mangaGateway.importWorkShare({
          previewId: shareImportPreview.previewId,
          target: payload.target,
          entries: payload.entries,
        });
        await refreshLibrary();
        resetWorkspaceHistory();
        applyChapter(
          result.openedChapter,
          t("share.importApplied", { count: result.chapterIds.length }),
        );
        setShareImportPreview(null);
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, t("share.importFailed")));
      } finally {
        setShareImportBusy(false);
      }
    },
    [
      applyChapter,
      askConfirm,
      dirty,
      pushStatus,
      refreshLibrary,
      resetWorkspaceHistory,
      saveNow,
      setShareImportBusy,
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

function useSubmitImportAction({
  applyChapter,
  dirty,
  importPreview,
  openTranslateOptions,
  pushStatus,
  refreshLibrary,
  resetWorkspaceHistory,
  saveNow,
  setImportBusy,
  setImportPreview,
}: UseImportShareActionsOptions): ImportShareActions["submitImport"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async ({ target, selections, linkedWorkspace }: ImportModalSubmit) => {
      if (!importPreview) {
        return;
      }

      setImportBusy(true);
      try {
        if (dirty) {
          await saveNow();
        }
        const result = await mangaGateway.createImport({
          previewId: importPreview.previewId,
          target,
          selections,
          ...(linkedWorkspace ? { linkedWorkspace } : {}),
        });
        await refreshLibrary();
        resetWorkspaceHistory();
        applyChapter(
          result.openedChapter,
          t("import.added", { count: result.chapterIds.length }),
        );
        setImportPreview(null);

        if (result.linkedWorkspaceWarning) {
          pushStatus(result.linkedWorkspaceWarning);
        }

        if (importPreview.mode === "batch") {
          openTranslateOptions("work-all");
        }
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, t("import.applyFailed")));
      } finally {
        setImportBusy(false);
      }
    },
    [
      applyChapter,
      dirty,
      importPreview,
      openTranslateOptions,
      pushStatus,
      refreshLibrary,
      resetWorkspaceHistory,
      saveNow,
      setImportBusy,
      setImportPreview,
      t,
    ],
  );
}
