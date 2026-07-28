import type {
  BubbleLayoutDraftMode,
  WorkspaceInteractionPreviewStore,
} from "./workspaceInteractionPreview";

export const MIN_BUBBLE_LAYOUT_BRUSH_RADIUS = 8;
export const MAX_BUBBLE_LAYOUT_BRUSH_RADIUS = 120;

export function selectBubbleLayoutDraftMode(
  store: WorkspaceInteractionPreviewStore,
  mode: BubbleLayoutDraftMode,
): void {
  const draft = store.getBubbleLayoutDraft();
  if (!draft || (mode !== "polygon" && !draft.shape)) return;
  if (draft.mode === mode) return;
  store.set({
    bubbleLayoutDraft: {
      ...draft,
      hoverPoint: null,
      mode,
      notice: null,
      points: mode === "polygon" ? [] : draft.points,
      stroke: null,
    },
  });
}

export function setBubbleLayoutDraftBrushRadius(
  store: WorkspaceInteractionPreviewStore,
  value: number,
): void {
  const draft = store.getBubbleLayoutDraft();
  if (!draft || !Number.isFinite(value)) return;
  store.set({
    bubbleLayoutDraft: {
      ...draft,
      brushRadius: Math.max(
        MIN_BUBBLE_LAYOUT_BRUSH_RADIUS,
        Math.min(MAX_BUBBLE_LAYOUT_BRUSH_RADIUS, value),
      ),
    },
  });
}
