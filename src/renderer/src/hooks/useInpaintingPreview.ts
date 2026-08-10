import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { inpaintingGateway } from "../api/inpaintingGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import { captureWorkspaceMaskSnapshot } from "../lib/workspaceHistory";
import type {
  InpaintingPreviewStageInput,
  UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export type InpaintingPreviewState = {
  transactionId: string;
  chapterId: string;
  pageId: string;
  pageName: string;
  beforeChapter: ChapterSnapshot;
  afterChapter: ChapterSnapshot;
  label: string;
  maskBefore?: InpaintingMaskStroke[];
  pagesChanged: number;
  blocksErased: number;
  pagesIncomplete: number;
  blocksIncomplete: number;
};

export type InpaintingPreviewController = {
  preview: InpaintingPreviewState | null;
  busy: boolean;
  error: string | null;
  stage: (input: InpaintingPreviewStageInput) => Promise<boolean>;
  apply: () => Promise<void>;
  discard: () => Promise<void>;
};

export function useInpaintingPreview(
  options: UseInpaintingActionsOptions,
): InpaintingPreviewController {
  const { t } = useTranslation("renderer");
  const [preview, setPreview] = useState<InpaintingPreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<InpaintingPreviewState | null>(null);
  const busyRef = useRef(false);
  const replacePreview = useCallback((next: InpaintingPreviewState | null) => {
    previewRef.current = next;
    setPreview(next);
  }, []);
  const replaceBusy = useCallback((next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  }, []);
  const store = { previewRef, busyRef, replacePreview, replaceBusy, setError };
  const stage = useStageInpaintingPreview(options, store, t);
  const apply = useApplyInpaintingPreview(options, store, t);
  const discard = useDiscardInpaintingPreview(options, store, t);
  useReleasePreviewOnUnmount(previewRef);

  return { preview, busy, error, stage, apply, discard };
}

type PreviewStore = {
  previewRef: React.MutableRefObject<InpaintingPreviewState | null>;
  busyRef: React.MutableRefObject<boolean>;
  replacePreview: (next: InpaintingPreviewState | null) => void;
  replaceBusy: (next: boolean) => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
};

function useStageInpaintingPreview(
  options: UseInpaintingActionsOptions,
  store: PreviewStore,
  t: TFunction<"renderer">,
): InpaintingPreviewController["stage"] {
  return useCallback(
    async (input: InpaintingPreviewStageInput): Promise<boolean> => {
      if (store.previewRef.current || store.busyRef.current) return false;
      store.replaceBusy(true);
      try {
        const staged = await createStagedPreview(input, t);
        if (!staged) return false;
        options.clearRetouchHistory();
        options.clearPageImageCache();
        // Storage has already been rolled back. The live chapter deliberately
        // shows the retained result artifact while the modal owns all input.
        options.mergeLiveChapter(input.afterChapter);
        store.setError(null);
        store.replacePreview(staged);
        return true;
      } finally {
        store.replaceBusy(false);
      }
    },
    [options, store, t],
  );
}

async function createStagedPreview(
  input: InpaintingPreviewStageInput,
  t: TFunction<"renderer">,
): Promise<InpaintingPreviewState | null> {
  const transactionId = input.result.historyTransaction?.transactionId;
  const afterPage = input.afterChapter.pages.find(
    (page) => page.id === input.pageId,
  );
  if (!transactionId || !afterPage) return null;
  const restored = await inpaintingGateway.applyInpaintingHistoryTransaction({
    transactionId,
    direction: "undo",
  });
  const beforeChapter = restored.chapters.find(
    (chapter) => chapter.id === input.afterChapter.id,
  );
  if (restored.invalidated || !beforeChapter) {
    throw new Error(t("inpainting.preview.prepareConflict"));
  }
  return {
    transactionId,
    chapterId: input.afterChapter.id,
    pageId: input.pageId,
    pageName: afterPage.name,
    beforeChapter,
    afterChapter: input.afterChapter,
    label: input.label,
    maskBefore: input.maskBefore,
    pagesChanged: input.result.pagesChanged ?? 0,
    blocksErased: input.result.blocksErased ?? 0,
    pagesIncomplete: input.result.pagesIncomplete ?? 0,
    blocksIncomplete: input.result.blocksIncomplete ?? 0,
  };
}

function useApplyInpaintingPreview(
  options: UseInpaintingActionsOptions,
  store: PreviewStore,
  t: TFunction<"renderer">,
): InpaintingPreviewController["apply"] {
  return useCallback(async (): Promise<void> => {
    const current = store.previewRef.current;
    if (!current || store.busyRef.current) return;
    store.replaceBusy(true);
    store.setError(null);
    try {
      const applied = await inpaintingGateway.applyInpaintingHistoryTransaction(
        {
          transactionId: current.transactionId,
          direction: "redo",
        },
      );
      const chapter = applied.chapters.find(
        (candidate) => candidate.id === current.chapterId,
      );
      if (chapter) options.mergeLiveChapter(chapter);
      if (applied.invalidated) {
        store.replacePreview(null);
        options.clearPageImageCache();
        options.pushStatus(t("inpainting.preview.applyConflict"));
        return;
      }
      recordAppliedPreview(current, options);
      store.replacePreview(null);
      options.clearPageImageCache();
      options.pushStatus(t("inpainting.preview.applied"));
      void options.refreshLibrary();
    } catch (applyError) {
      console.error(applyError);
      store.setError(
        formatErrorMessage(applyError, t("inpainting.preview.applyFailed")),
      );
    } finally {
      store.replaceBusy(false);
    }
  }, [options, store, t]);
}

function recordAppliedPreview(
  current: InpaintingPreviewState,
  options: UseInpaintingActionsOptions,
): void {
  const mask = current.maskBefore
    ? {
        before: captureWorkspaceMaskSnapshot(
          current.chapterId,
          current.pageId,
          current.maskBefore,
        ),
        after: captureWorkspaceMaskSnapshot(
          current.chapterId,
          current.pageId,
          [],
        ),
      }
    : undefined;
  options.workspaceHistory.recordImageEdit({
    label: current.label,
    transactionId: current.transactionId,
    chapterId: current.chapterId,
    mask,
  });
  if (!current.maskBefore) return;
  options.setPatternMaskStrokesByPage((pages) => {
    const next = { ...pages };
    delete next[current.pageId];
    return next;
  });
}

function useDiscardInpaintingPreview(
  options: UseInpaintingActionsOptions,
  store: PreviewStore,
  t: TFunction<"renderer">,
): InpaintingPreviewController["discard"] {
  return useCallback(async (): Promise<void> => {
    const current = store.previewRef.current;
    if (!current || store.busyRef.current) return;
    store.replaceBusy(true);
    store.setError(null);
    try {
      await inpaintingGateway.releaseInpaintingHistoryTransactions({
        transactionIds: [current.transactionId],
      });
      options.clearPageImageCache();
      options.mergeLiveChapter(current.beforeChapter);
      store.replacePreview(null);
      options.pushStatus(t("inpainting.preview.discarded"));
      void options.refreshLibrary();
    } catch (discardError) {
      console.error(discardError);
      store.setError(
        formatErrorMessage(discardError, t("inpainting.preview.discardFailed")),
      );
    } finally {
      store.replaceBusy(false);
    }
  }, [options, store, t]);
}

function useReleasePreviewOnUnmount(
  previewRef: React.MutableRefObject<InpaintingPreviewState | null>,
): void {
  useEffect(
    () => () => {
      const current = previewRef.current;
      if (!current) return;
      void inpaintingGateway.releaseInpaintingHistoryTransactions({
        transactionIds: [current.transactionId],
      });
    },
    [previewRef],
  );
}
