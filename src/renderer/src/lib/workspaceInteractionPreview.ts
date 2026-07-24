import { useCallback, useSyncExternalStore } from "react";
import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import type { DragHud } from "./workspaceInteractionTypes";

type BlockInteractionPreview = {
  block: TranslationBlock;
  blockId: string;
};

type WorkspaceInteractionPreviewState = {
  blockCreateRect: BBox | null;
  blockPreview: BlockInteractionPreview | null;
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
    next.dragHud === current.dragHud &&
    next.regionSelectionRect === current.regionSelectionRect
    ? current
    : next;
}
