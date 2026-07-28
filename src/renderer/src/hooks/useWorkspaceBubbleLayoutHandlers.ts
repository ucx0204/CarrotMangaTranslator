import {
  useCallback,
  useEffect,
  type PointerEvent,
  type RefObject,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import {
  appendBubbleLayoutPolygonPoint,
  createBubbleLayoutDraft,
  resolveBubbleLayoutDraftShapeForApply,
  undoBubbleLayoutDraft,
} from "../lib/bubbleLayoutDraft";
import {
  finishBubbleLayoutBrushStroke,
  startBubbleLayoutBrushStroke,
  updateBubbleLayoutBrushStroke,
} from "../lib/bubbleLayoutBrushGesture";
import { scheduleBubbleLayoutNoticeClear } from "../lib/bubbleLayoutBrushFeedback";
import type { BubbleLayoutSculptRejectReason } from "../lib/bubbleLayoutSculpt";
import type {
  BubbleLayoutDraftPreview,
  WorkspaceInteractionPreviewStore,
} from "../lib/workspaceInteractionPreview";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import {
  resolveNormalizedImagePoint,
  type PointerRect,
} from "./workspacePointerGeometry";

type UseWorkspaceBubbleLayoutHandlersOptions = {
  active: boolean;
  getImagePointerRect: () => PointerRect | null;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  onFinished: () => void;
  pushStatus: (line: string) => void;
  selectedBlockId: string | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  updateCurrentChapter: UpdateCurrentChapter;
};

export type WorkspaceBubbleLayoutHandlers = {
  applyBubbleLayoutDraft: () => boolean;
  cancelBubbleLayoutDraft: () => boolean;
  onBubbleLayoutPointerDown: (event: PointerEvent) => boolean;
  onBubbleLayoutPointerLeave: () => void;
  onBubbleLayoutPointerMove: (event: PointerEvent) => boolean;
  onBubbleLayoutPointerUp: (event: PointerEvent) => boolean;
  undoBubbleLayoutPoint: () => void;
};

/**
 * Draft-only polygon and sculpt editor for a selected block's bubble shape.
 * Only Apply writes chapter state and creates one workspace-history entry.
 */
export function useWorkspaceBubbleLayoutHandlers(
  options: UseWorkspaceBubbleLayoutHandlersOptions,
): WorkspaceBubbleLayoutHandlers {
  const { t } = useTranslation("renderer");
  const {
    active,
    interactionPreviewStore,
    onFinished,
    pushStatus,
    selectedBlockId,
    selectedPage,
    stageRef,
  } = options;

  useEffect(() => {
    const block = selectedPage?.blocks.find(
      (candidate) => candidate.id === selectedBlockId,
    );
    if (!active || !selectedPage || !block) {
      interactionPreviewStore.set({ bubbleLayoutDraft: null });
      return;
    }
    const current = interactionPreviewStore.getBubbleLayoutDraft();
    if (current?.blockId !== block.id) {
      interactionPreviewStore.set({
        bubbleLayoutDraft: createBubbleLayoutDraft(block, selectedPage),
      });
    }
  }, [active, interactionPreviewStore, selectedBlockId, selectedPage]);

  const cancelBubbleLayoutDraft = useCallback(() => {
    const draft = interactionPreviewStore.getBubbleLayoutDraft();
    if (!active && !draft) return false;
    if (draft?.stroke) {
      releasePointerCaptureSafely(stageRef.current, draft.stroke.pointerId);
    }
    interactionPreviewStore.set({ bubbleLayoutDraft: null });
    if (draft?.dirty || draft?.points.length) {
      pushStatus(t("bubbleLayoutEditor.cancelled"));
    }
    onFinished();
    return true;
  }, [active, interactionPreviewStore, onFinished, pushStatus, stageRef, t]);

  const applyBubbleLayoutDraft = useApplyBubbleLayoutDraft(options, t);
  const undoBubbleLayoutPoint = useCallback(() => {
    const draft = interactionPreviewStore.getBubbleLayoutDraft();
    if (!draft || draft.history.length === 0) return;
    interactionPreviewStore.set({
      bubbleLayoutDraft: undoBubbleLayoutDraft(draft),
    });
  }, [interactionPreviewStore]);

  useBubbleLayoutKeyboardShortcuts({
    active,
    applyBubbleLayoutDraft,
    undoBubbleLayoutPoint,
  });

  return {
    applyBubbleLayoutDraft,
    cancelBubbleLayoutDraft,
    onBubbleLayoutPointerDown: useBubbleLayoutPointerDown(options),
    onBubbleLayoutPointerLeave: useCallback(() => {
      const draft = interactionPreviewStore.getBubbleLayoutDraft();
      if (draft?.hoverPoint) {
        interactionPreviewStore.set({
          bubbleLayoutDraft: { ...draft, hoverPoint: null },
        });
      }
    }, [interactionPreviewStore]),
    onBubbleLayoutPointerMove: useBubbleLayoutPointerMove(options),
    onBubbleLayoutPointerUp: useBubbleLayoutPointerUp(options, t),
    undoBubbleLayoutPoint,
  };
}

function useBubbleLayoutPointerDown({
  active,
  getImagePointerRect,
  interactionPreviewStore,
  selectedBlockId,
  selectedPage,
  selectedPageEditLocked,
  stageRef,
}: UseWorkspaceBubbleLayoutHandlersOptions): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!active) return false;
      if (
        isBubbleLayoutPointerUnavailable({
          event,
          selectedBlockId,
          selectedPage,
          selectedPageEditLocked,
        })
      ) {
        return true;
      }
      const point = resolveBubbleLayoutPointerPoint(event, getImagePointerRect);
      if (!point || !stageRef.current) return true;
      event.preventDefault();
      event.stopPropagation();
      const current = interactionPreviewStore.getBubbleLayoutDraft();
      if (!current || current.blockId !== selectedBlockId) return true;
      interactionPreviewStore.set({
        bubbleLayoutDraft: updateBubbleLayoutPointerDraft(
          current,
          point,
          event.pointerId,
        ),
      });
      if (current.mode !== "polygon" && current.shape) {
        capturePointerSafely(stageRef.current, event.pointerId);
      }
      return true;
    },
    [
      active,
      getImagePointerRect,
      interactionPreviewStore,
      selectedBlockId,
      selectedPage,
      selectedPageEditLocked,
      stageRef,
    ],
  );
}

function isBubbleLayoutPointerUnavailable({
  event,
  selectedBlockId,
  selectedPage,
  selectedPageEditLocked,
}: {
  event: PointerEvent;
  selectedBlockId: string | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
}): boolean {
  return (
    !selectedPage ||
    !selectedBlockId ||
    selectedPageEditLocked ||
    event.button !== 0
  );
}

function resolveBubbleLayoutPointerPoint(
  event: PointerEvent,
  getImagePointerRect: () => PointerRect | null,
): { x: number; y: number } | null {
  const pointerRect = getImagePointerRect();
  return pointerRect ? resolveNormalizedImagePoint(event, pointerRect) : null;
}

function updateBubbleLayoutPointerDraft(
  draft: BubbleLayoutDraftPreview,
  point: { x: number; y: number },
  pointerId: number,
): BubbleLayoutDraftPreview {
  return draft.mode === "polygon"
    ? appendBubbleLayoutPolygonPoint(draft, point)
    : startBubbleLayoutBrushStroke(draft, point, pointerId);
}

function useBubbleLayoutPointerMove({
  active,
  getImagePointerRect,
  interactionPreviewStore,
  selectedBlockId,
}: UseWorkspaceBubbleLayoutHandlersOptions): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!active) return false;
      const draft = interactionPreviewStore.getBubbleLayoutDraft();
      if (!draft || draft.blockId !== selectedBlockId) return true;
      const pointerRect = getImagePointerRect();
      const point = pointerRect
        ? resolveNormalizedImagePoint(event, pointerRect)
        : null;
      if (point) {
        const next =
          draft.stroke && draft.mode !== "polygon"
            ? updateBubbleLayoutBrushStroke(draft, point)
            : { ...draft, hoverPoint: point };
        const patch = { bubbleLayoutDraft: next };
        if (draft.stroke) interactionPreviewStore.set(patch);
        else interactionPreviewStore.queue(patch);
      }
      return true;
    },
    [active, getImagePointerRect, interactionPreviewStore, selectedBlockId],
  );
}

function useBubbleLayoutPointerUp(
  {
    active,
    getImagePointerRect,
    interactionPreviewStore,
    pushStatus,
    stageRef,
  }: UseWorkspaceBubbleLayoutHandlersOptions,
  t: TFunction<"renderer">,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!active) return false;
      const draft = interactionPreviewStore.getBubbleLayoutDraft();
      if (!draft?.stroke || draft.stroke.pointerId !== event.pointerId) {
        return true;
      }
      releasePointerCaptureSafely(stageRef.current, event.pointerId);
      const rect = getImagePointerRect();
      const point = rect ? resolveNormalizedImagePoint(event, rect) : null;
      const preview = point
        ? updateBubbleLayoutBrushStroke(draft, point)
        : draft;
      const result = finishBubbleLayoutBrushStroke(preview);
      interactionPreviewStore.set({
        bubbleLayoutDraft: {
          ...result.draft,
          notice: result.rejection,
        },
      });
      if (result.rejection) {
        pushStatus(resolveBrushRejectionMessage(result.rejection, t));
        scheduleBubbleLayoutNoticeClear(
          interactionPreviewStore,
          result.draft.blockId,
          result.rejection,
        );
      }
      return true;
    },
    [
      active,
      getImagePointerRect,
      interactionPreviewStore,
      pushStatus,
      stageRef,
      t,
    ],
  );
}

function resolveBrushRejectionMessage(
  reason: BubbleLayoutSculptRejectReason,
  t: TFunction<"renderer">,
): string {
  if (reason === "detached") {
    return t("bubbleLayoutEditor.brushDetached");
  }
  if (reason === "disconnect") {
    return t("bubbleLayoutEditor.brushDisconnect");
  }
  if (reason === "empty") return t("bubbleLayoutEditor.brushNoChange");
  return t("bubbleLayoutEditor.invalidRegion");
}

function useApplyBubbleLayoutDraft(
  {
    interactionPreviewStore,
    onFinished,
    pushStatus,
    selectedBlockId,
    selectedPage,
    updateCurrentChapter,
  }: UseWorkspaceBubbleLayoutHandlersOptions,
  t: TFunction<"renderer">,
): () => boolean {
  return useCallback(() => {
    const draft = interactionPreviewStore.getBubbleLayoutDraft();
    const block = selectedPage?.blocks.find(
      (candidate) => candidate.id === selectedBlockId,
    );
    if (!draft || !selectedPage || !block || draft.blockId !== block.id) {
      return false;
    }
    if (draft.mode === "polygon" && draft.points.length < 3) {
      pushStatus(t("bubbleLayoutEditor.needsMorePoints"));
      return false;
    }
    const shape = resolveBubbleLayoutDraftShapeForApply(draft);
    if (!draft.dirty || !shape) {
      pushStatus(t("bubbleLayoutEditor.invalidRegion"));
      return false;
    }
    updateCurrentChapter(
      selectedPage.id,
      (chapter) => ({
        ...chapter,
        pages: chapter.pages.map((page) =>
          page.id !== selectedPage.id
            ? page
            : {
                ...page,
                updatedAt: new Date().toISOString(),
                blocks: page.blocks.map((candidate) =>
                  candidate.id === block.id
                    ? { ...candidate, ...shape }
                    : candidate,
                ),
              },
        ),
      }),
      { label: t("workspaceHistory.bubbleLayoutManual") },
    );
    interactionPreviewStore.set({ bubbleLayoutDraft: null });
    pushStatus(t("bubbleLayoutEditor.applied"));
    onFinished();
    return true;
  }, [
    interactionPreviewStore,
    onFinished,
    pushStatus,
    selectedBlockId,
    selectedPage,
    t,
    updateCurrentChapter,
  ]);
}

function useBubbleLayoutKeyboardShortcuts({
  active,
  applyBubbleLayoutDraft,
  undoBubbleLayoutPoint,
}: {
  active: boolean;
  applyBubbleLayoutDraft: () => boolean;
  undoBubbleLayoutPoint: () => void;
}): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTextEntryTarget(event.target)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        applyBubbleLayoutDraft();
      } else if (event.key === "Backspace") {
        event.preventDefault();
        undoBubbleLayoutPoint();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, applyBubbleLayoutDraft, undoBubbleLayoutPoint]);
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
