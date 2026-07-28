import React from "react";
import { useTranslation } from "react-i18next";
import { resolveBubbleLayoutDraftShapeForApply } from "../lib/bubbleLayoutDraft";
import {
  MAX_BUBBLE_LAYOUT_BRUSH_RADIUS,
  MIN_BUBBLE_LAYOUT_BRUSH_RADIUS,
  selectBubbleLayoutDraftMode,
  setBubbleLayoutDraftBrushRadius,
} from "../lib/bubbleLayoutDraftControls";
import {
  useBubbleLayoutDraftPreview,
  type BubbleLayoutDraftPreview,
  type WorkspaceInteractionPreviewStore,
} from "../lib/workspaceInteractionPreview";

type BubbleLayoutContextBarProps = {
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  onApply: () => void;
  onCancel: () => void;
  onUndoPoint: () => void;
};

/**
 * Transaction controls for manual bubble-shape editing.
 *
 * This component owns its preview-store subscription so high-frequency pointer
 * previews update only the bar and SVG overlay, not the whole workspace shell.
 */
export function BubbleLayoutContextBar({
  interactionPreviewStore,
  onApply,
  onCancel,
  onUndoPoint,
}: BubbleLayoutContextBarProps): React.JSX.Element | null {
  const draft = useBubbleLayoutDraftPreview(interactionPreviewStore);
  if (!draft) return null;
  return (
    <BubbleLayoutContextBarContent
      draft={draft}
      interactionPreviewStore={interactionPreviewStore}
      onApply={onApply}
      onCancel={onCancel}
      onUndoPoint={onUndoPoint}
    />
  );
}

function BubbleLayoutContextBarContent({
  draft,
  interactionPreviewStore,
  onApply,
  onCancel,
  onUndoPoint,
}: BubbleLayoutContextBarProps & {
  draft: BubbleLayoutDraftPreview;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const titleId = React.useId();
  const canApply =
    draft.dirty && Boolean(resolveBubbleLayoutDraftShapeForApply(draft));
  return (
    <section
      aria-labelledby={titleId}
      className="bubble-layout-context-bar"
      data-bubble-layout-context-bar=""
      role="region"
    >
      <div className="bubble-layout-context-info">
        <strong id={titleId}>{t("bubbleLayoutEditor.title")}</strong>
        <span
          aria-atomic="true"
          aria-live="polite"
          className={
            draft.notice
              ? "bubble-layout-context-hint bubble-layout-editor-notice"
              : "bubble-layout-context-hint"
          }
          data-bubble-layout-notice={draft.notice ?? undefined}
        >
          {resolveEditorHint(draft, t)}
        </span>
      </div>
      <BubbleLayoutModeToolbar
        draft={draft}
        interactionPreviewStore={interactionPreviewStore}
      />
      <div
        aria-label={t("bubbleLayoutEditor.title")}
        className="bubble-layout-context-actions"
        role="toolbar"
      >
        <button
          disabled={draft.history.length === 0}
          onClick={onUndoPoint}
          type="button"
        >
          {t("bubbleLayoutEditor.undo")}
        </button>
        <button onClick={onCancel} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="primary"
          disabled={!canApply}
          onClick={onApply}
          type="button"
        >
          {t("bubbleLayoutEditor.apply")}
        </button>
      </div>
    </section>
  );
}

function BubbleLayoutModeToolbar({
  draft,
  interactionPreviewStore,
}: {
  draft: BubbleLayoutDraftPreview;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      aria-label={t("bubbleLayoutEditor.modeLabel")}
      className="bubble-layout-context-modes"
      role="toolbar"
    >
      {(["polygon", "add", "subtract"] as const).map((mode) => (
        <button
          aria-pressed={draft.mode === mode}
          disabled={mode !== "polygon" && !draft.shape}
          key={mode}
          onClick={() =>
            selectBubbleLayoutDraftMode(interactionPreviewStore, mode)
          }
          type="button"
        >
          {t(`bubbleLayoutEditor.modes.${mode}`)}
        </button>
      ))}
      <label className="bubble-layout-context-radius">
        <span>{t("bubbleLayoutEditor.radius")}</span>
        <input
          aria-label={t("bubbleLayoutEditor.radius")}
          disabled={draft.mode === "polygon"}
          max={MAX_BUBBLE_LAYOUT_BRUSH_RADIUS}
          min={MIN_BUBBLE_LAYOUT_BRUSH_RADIUS}
          onChange={(event) =>
            setBubbleLayoutDraftBrushRadius(
              interactionPreviewStore,
              Number(event.currentTarget.value),
            )
          }
          type="range"
          value={draft.brushRadius}
        />
        <output>{Math.round(draft.brushRadius)}</output>
      </label>
    </div>
  );
}

function resolveEditorHint(
  draft: BubbleLayoutDraftPreview,
  t: ReturnType<typeof useTranslation<"components">>["t"],
): string {
  if (draft.notice) {
    return t(`bubbleLayoutEditor.rejections.${draft.notice}`);
  }
  if (draft.mode === "add") return t("bubbleLayoutEditor.addHint");
  if (draft.mode === "subtract") {
    return t("bubbleLayoutEditor.subtractHint");
  }
  return draft.points.length === 0
    ? t("bubbleLayoutEditor.emptyHint")
    : t("bubbleLayoutEditor.activeHint", { count: draft.points.length });
}
