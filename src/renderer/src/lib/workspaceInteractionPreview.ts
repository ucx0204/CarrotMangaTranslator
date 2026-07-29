import { useCallback, useSyncExternalStore } from "react";
import type { BubbleLayout } from "../../../shared/bubbleLayout";
import type { BBox, Point, TranslationBlock } from "../../../shared/textTypes";
import type { DragHud } from "./workspaceInteractionTypes";

type BlockInteractionPreview = {
  block: TranslationBlock;
  blockId: string;
};

export type BubbleLayoutDraftMode = "polygon" | "add" | "subtract";

export type BubbleLayoutDraftShape = {
  bubbleLayout: BubbleLayout;
  renderBbox: BBox;
  renderBboxSpace: "normalized_1000";
};

export type BubbleLayoutDraftSnapshot = {
  dirty: boolean;
  points: Point[];
  shape: BubbleLayoutDraftShape | null;
};

type BubbleLayoutDraftStroke = {
  base: BubbleLayoutDraftSnapshot;
  pointerId: number;
  points: Point[];
  result: "applied" | "detached" | "disconnect" | "empty" | "invalid";
};

export type BubbleLayoutDraftPreview = {
  blockId: string;
  brushRadius: number;
  direction: "horizontal" | "vertical";
  dirty: boolean;
  history: BubbleLayoutDraftSnapshot[];
  hoverPoint: Point | null;
  mode: BubbleLayoutDraftMode;
  notice: "detached" | "disconnect" | "empty" | "invalid" | null;
  points: Point[];
  shape: BubbleLayoutDraftShape | null;
  stroke: BubbleLayoutDraftStroke | null;
};

type WorkspaceInteractionPreviewState = {
  blockCreateRect: BBox | null;
  blockPreview: BlockInteractionPreview | null;
  bubbleLayoutDraft: BubbleLayoutDraftPreview | null;
  dragHud: DragHud | null;
  regionSelectionRect: BBox | null;
};

type WorkspaceInteractionPreviewPatch =
  Partial<WorkspaceInteractionPreviewState>;

export type WorkspaceInteractionPreviewStore = {
  clear: () => void;
  flush: () => void;
  getBlockCreateRect: () => BBox | null;
  getBlockPreview: (blockId: string) => TranslationBlock | null;
  getBubbleLayoutDraft: () => BubbleLayoutDraftPreview | null;
  getDragHud: () => DragHud | null;
  getRegionSelectionRect: () => BBox | null;
  getSnapshot: () => WorkspaceInteractionPreviewState;
  queue: (patch: WorkspaceInteractionPreviewPatch) => void;
  reset: () => void;
  set: (patch: WorkspaceInteractionPreviewPatch) => void;
  subscribe: (listener: () => void) => () => void;
};

const EMPTY_PREVIEW_STATE: WorkspaceInteractionPreviewState = {
  blockCreateRect: null,
  blockPreview: null,
  bubbleLayoutDraft: null,
  dragHud: null,
  regionSelectionRect: null,
};

export function createWorkspaceInteractionPreviewStore(): WorkspaceInteractionPreviewStore {
  let state = EMPTY_PREVIEW_STATE;
  let queuedPatch: WorkspaceInteractionPreviewPatch | null = null;
  let frameId: number | null = null;
  const listeners = new Set<() => void>();

  const publishQueuedPatch = (): void => {
    frameId = null;
    if (!queuedPatch) return;
    const next = mergePreviewState(state, queuedPatch);
    queuedPatch = null;
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const flush = (): void => {
    if (frameId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    publishQueuedPatch();
  };

  const set = (patch: WorkspaceInteractionPreviewPatch): void => {
    queuedPatch = queuedPatch ? { ...queuedPatch, ...patch } : patch;
    flush();
  };

  const clear = (): void => {
    set(EMPTY_PREVIEW_STATE);
  };

  return {
    clear,
    reset() {
      if (frameId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameId);
      }
      frameId = null;
      queuedPatch = null;
      state = EMPTY_PREVIEW_STATE;
    },
    flush,
    getBlockCreateRect: () => state.blockCreateRect,
    getBlockPreview: (blockId) =>
      state.blockPreview?.blockId === blockId ? state.blockPreview.block : null,
    getBubbleLayoutDraft: () => state.bubbleLayoutDraft,
    getDragHud: () => state.dragHud,
    getRegionSelectionRect: () => state.regionSelectionRect,
    getSnapshot: () => state,
    queue(patch) {
      queuedPatch = queuedPatch ? { ...queuedPatch, ...patch } : patch;
      if (frameId !== null) return;
      if (typeof requestAnimationFrame !== "function") {
        publishQueuedPatch();
        return;
      }
      frameId = requestAnimationFrame(publishQueuedPatch);
    },
    set,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useBlockInteractionPreview(
  store: WorkspaceInteractionPreviewStore,
  blockId: string,
): TranslationBlock | null {
  const getSnapshot = useCallback(
    () => store.getBlockPreview(blockId),
    [blockId, store],
  );
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useBlockCreateRectPreview(
  store: WorkspaceInteractionPreviewStore,
): BBox | null {
  return useSyncExternalStore(
    store.subscribe,
    store.getBlockCreateRect,
    store.getBlockCreateRect,
  );
}

export function useBubbleLayoutDraftPreview(
  store: WorkspaceInteractionPreviewStore,
): BubbleLayoutDraftPreview | null {
  return useSyncExternalStore(
    store.subscribe,
    store.getBubbleLayoutDraft,
    store.getBubbleLayoutDraft,
  );
}

export function useDragHudPreview(
  store: WorkspaceInteractionPreviewStore,
): DragHud | null {
  return useSyncExternalStore(
    store.subscribe,
    store.getDragHud,
    store.getDragHud,
  );
}

export function useRegionSelectionRectPreview(
  store: WorkspaceInteractionPreviewStore,
): BBox | null {
  return useSyncExternalStore(
    store.subscribe,
    store.getRegionSelectionRect,
    store.getRegionSelectionRect,
  );
}

function mergePreviewState(
  current: WorkspaceInteractionPreviewState,
  patch: WorkspaceInteractionPreviewPatch,
): WorkspaceInteractionPreviewState {
  const next = { ...current, ...patch };
  return next.blockCreateRect === current.blockCreateRect &&
    next.blockPreview === current.blockPreview &&
    next.bubbleLayoutDraft === current.bubbleLayoutDraft &&
    next.dragHud === current.dragHud &&
    next.regionSelectionRect === current.regionSelectionRect
    ? current
    : next;
}
