import { useCallback, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { ImportPreviewSession } from "../../../shared/importTypes";
import type {
  WorkShareExportRequest,
  WorkShareImportPreview,
} from "../../../shared/shareTypes";
import type { ImportModalSubmit } from "../components/ImportModal";
import type { ShareImportModalSubmit } from "../components/ShareImportModal";
import type { TranslateSourceMode } from "../components/TranslateSourceModal";
import { formatErrorMessage } from "../lib/appHelpers";
import { mangaGateway } from "../api/mangaGateway";

type ImportPreviewMode = TranslateSourceMode | "zip-folder";

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
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  openChapter: (chapterId: string) => Promise<void>;
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
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
  shareImportPreview: WorkShareImportPreview | null;
};

type ImportShareActions = {
  openImportPreview: (mode: ImportPreviewMode) => Promise<void>;
  openShareImportPreview: () => Promise<void>;
  selectTranslateSource: (mode: TranslateSourceMode) => Promise<void>;
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
  const submitImport = useSubmitImportAction(options);
  const submitShareExport = useSubmitShareExportAction(options);
  const submitShareImport = useSubmitShareImportAction(options);

  return {
    openImportPreview,
    openShareImportPreview,
    selectTranslateSource,
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
}: UseImportShareActionsOptions & {
  openImportPreview: ImportShareActions["openImportPreview"];
}): ImportShareActions["selectTranslateSource"] {
  return useCallback(
    async (mode: TranslateSourceMode) => {
      setTranslationSourceOpen(false);
      await openImportPreview(mode);
    },
    [openImportPreview, setTranslationSourceOpen],
  );
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

      if (payload.remainingPackageChapters.length > 0) {
        const confirmed = await askConfirm(
          t("share.remainingChaptersTitle"),
          t("share.remainingChaptersMessage"),
          payload.remainingPackageChapters
            .map((chapter) => chapter.title)
            .join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      if (payload.deletedExistingChapters.length > 0) {
        const confirmed = await askConfirm(
          t("share.deleteExistingTitle"),
          t("share.deleteExistingMessage"),
          payload.deletedExistingChapters
            .map((chapter) => chapter.title)
            .join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

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
      saveNow,
      setShareImportBusy,
      setShareImportPreview,
      shareImportPreview,
      t,
    ],
  );
}

function useSubmitImportAction({
  applyChapter,
  dirty,
  importPreview,
  mergeLiveChapter,
  openChapter,
  pushStatus,
  refreshLibrary,
  saveNow,
  setImportBusy,
  setImportPreview,
}: UseImportShareActionsOptions): ImportShareActions["submitImport"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async ({ target, selections }: ImportModalSubmit) => {
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
        });
        await refreshLibrary();
        applyChapter(
          result.openedChapter,
          t("import.added", { count: result.chapterIds.length }),
        );
        setImportPreview(null);

        if (importPreview.mode === "batch") {
          await runImportedBatchAnalysis({
            chapterIds: result.chapterIds,
            mergeLiveChapter,
            openChapter,
            refreshLibrary,
          });
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
      mergeLiveChapter,
      openChapter,
      pushStatus,
      refreshLibrary,
      saveNow,
      setImportBusy,
      setImportPreview,
      t,
    ],
  );
}

async function runImportedBatchAnalysis({
  chapterIds,
  mergeLiveChapter,
  openChapter,
  refreshLibrary,
}: {
  chapterIds: string[];
  mergeLiveChapter: UseImportShareActionsOptions["mergeLiveChapter"];
  openChapter: UseImportShareActionsOptions["openChapter"];
  refreshLibrary: UseImportShareActionsOptions["refreshLibrary"];
}): Promise<void> {
  for (const chapterId of chapterIds) {
    await openChapter(chapterId);
    const runResult = await mangaGateway.startAnalysis({
      chapterId,
      runMode: "pending",
    });
    if (runResult.chapter) {
      mergeLiveChapter(runResult.chapter);
    }
    await refreshLibrary();
    if (runResult.status !== "completed") {
      return;
    }
  }
}
