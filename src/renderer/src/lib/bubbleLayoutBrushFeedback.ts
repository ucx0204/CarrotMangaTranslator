import type { BubbleLayoutSculptRejectReason } from "./bubbleLayoutSculpt";
import type { WorkspaceInteractionPreviewStore } from "./workspaceInteractionPreview";

export function scheduleBubbleLayoutNoticeClear(
  store: WorkspaceInteractionPreviewStore,
  blockId: string,
  notice: BubbleLayoutSculptRejectReason,
): void {
  window.setTimeout(() => {
    const current = store.getBubbleLayoutDraft();
    if (current?.blockId !== blockId || current.notice !== notice) return;
    store.set({
      bubbleLayoutDraft: { ...current, notice: null },
    });
  }, 2600);
}
