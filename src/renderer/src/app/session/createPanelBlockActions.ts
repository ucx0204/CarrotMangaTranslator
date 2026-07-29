import type { PanelSessionValue } from "../../panels/panelSession";
import type { AppSessionViewModel } from "./appSessionViewModel";

type PanelBlockActions = Pick<
  PanelSessionValue,
  "onEraseBlockOriginal" | "onFitBlockBubble"
>;

export function createPanelBlockActions({
  derivedState,
  inpaintingActions,
}: AppSessionViewModel): PanelBlockActions {
  return {
    onEraseBlockOriginal: () => {
      const blockId = derivedState.selectedBlock?.id;
      if (blockId) void inpaintingActions.runInpainting("page", blockId);
    },
    onFitBlockBubble: () => {
      const blockId = derivedState.selectedBlock?.id;
      if (blockId) void inpaintingActions.runBubbleLayout(blockId);
    },
  };
}
