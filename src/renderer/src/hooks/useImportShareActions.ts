import { useCallback, type Dispatch, type SetStateAction } from "react";
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
  return useCallback(
    async (mode: ImportPreviewMode) => {
      try {
        const preview = await requestImportPreview(mode);
        if (preview) {
          setImportPreview(preview);
        }
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, "번역할 원본을 읽지 못했습니다."));
      }
    },
    [pushStatus, setImportPreview],
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
            `${result.workTitle} 공유 파일을 저장했습니다. ${result.chapterCount}개 화, ${result.pageCount}페이지`,
          );
          setShareExportOpen(false);
        }
      } catch (error) {
        console.error(error);
        pushStatus(
          formatErrorMessage(error, "공유 파일을 저장하지 못했습니다."),
        );
      } finally {
        setShareExportBusy(false);
      }
    },
    [dirty, pushStatus, saveNow, setShareExportBusy, setShareExportOpen],
  );
}

function useOpenShareImportPreviewAction({
  dirty,
  pushStatus,
  saveNow,
  setShareImportPreview,
}: UseImportShareActionsOptions): ImportShareActions["openShareImportPreview"] {
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
      pushStatus(formatErrorMessage(error, "공유 파일을 읽지 못했습니다."));
    }
  }, [dirty, pushStatus, saveNow, setShareImportPreview]);
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
  return useCallback(
    async (payload: ShareImportModalSubmit) => {
      if (!shareImportPreview) {
        return;
      }

      if (payload.remainingPackageChapters.length > 0) {
        const confirmed = await askConfirm(
          "가져오지 않는 화가 있습니다",
          "오른쪽에 남은 공유 화는 적용되지 않습니다.",
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
          "기존 화 삭제",
          "왼쪽 최종 목록에서 빠진 기존 화가 보관함에서 삭제됩니다.",
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
          `${result.chapterIds.length}개 화를 보관함에 적용했습니다.`,
        );
        setShareImportPreview(null);
      } catch (error) {
        console.error(error);
        pushStatus(
          formatErrorMessage(error, "공유 파일을 가져오지 못했습니다."),
        );
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
          `${result.chapterIds.length}개 화를 보관함에 추가했습니다.`,
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
        pushStatus(
          formatErrorMessage(error, "가져오기를 적용하지 못했습니다."),
        );
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
