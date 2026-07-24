import React from "react";
import { useDragHudPreview } from "../lib/workspaceInteractionPreview";
import type { ImageStageProps } from "./imageStageTypes";

export const StageDragHud = React.memo(function StageDragHud({
  interactionPreviewStore,
}: {
  interactionPreviewStore: ImageStageProps["interactionPreviewStore"];
}): React.JSX.Element | null {
  const dragHud = useDragHudPreview(interactionPreviewStore);
  return dragHud ? (
    <div
      className={`stage-drag-hud ${dragHud.mode}${dragHud.invalid ? " invalid" : ""}`}
    >
      {dragHud.label}
    </div>
  ) : null;
});
