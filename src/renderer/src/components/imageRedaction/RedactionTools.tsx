import React from "react";
import { useTranslation } from "react-i18next";
import type { RedactionPreferences } from "../../../../shared/imageRedactionWorkspace";
import { Button } from "../ui/Button";
import { NumberField } from "../ui/NumberField";
import { SegmentedControl } from "../ui/SegmentedControl";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import {
  canRestoreRedactionEdit,
  restoreRedactionEdit,
} from "./redactionSession";
import {
  changeRedactionPreferences,
  changeRedactionStrokes,
  changeRedactionView,
} from "./redactionWorkspaceModel";
import styles from "./RedactionWorkspace.module.css";

type ToolProps = {
  form: RedactionWorkspaceController;
  selected: number;
  setSelected: (index: number) => void;
  onPreviousMask: () => void;
  onPresets: () => void;
};
export function RedactionTools({
  form,
  selected,
  setSelected,
  onPreviousMask,
  onPresets,
}: ToolProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { state, commit } = form;
  const id = state.workspace.view.currentId;
  const preferences = state.workspace.preferences;
  const disabled = form.busy || form.drawing;
  return (
    <div className={styles.tools}>
      <SegmentedControl
        singleRow
        ariaLabel={t("manualRedaction.tool")}
        value={preferences.tool}
        disabled={disabled}
        options={(
          ["rectangle", "brush", "erase", "select", "pan"] as const
        ).map((value) => ({
          id: value,
          label: t(`manualRedaction.tool_${value}`),
        }))}
        onChange={(tool: RedactionPreferences["tool"]) =>
          commit((current) => changeRedactionPreferences(current, { tool }))
        }
      />
      {preferences.tool === "brush" || preferences.tool === "erase" ? (
        <>
          <SegmentedControl
            singleRow
            ariaLabel={t("imageRedaction.shape")}
            value={preferences.shape}
            disabled={disabled}
            options={(["round", "square"] as const).map((value) => ({
              id: value,
              label: t(`imageRedaction.${value}`),
            }))}
            onChange={(shape) =>
              commit((current) =>
                changeRedactionPreferences(current, { shape }),
              )
            }
          />
          <NumberField
            className={styles.number}
            variant="framed"
            ariaLabel={t("imageRedaction.size")}
            min={1}
            max={1000}
            value={preferences.size}
            onValueChange={(size) =>
              commit((current) => changeRedactionPreferences(current, { size }))
            }
            unit="px"
            disabled={disabled}
          />
        </>
      ) : null}
      <Button
        size="sm"
        disabled={disabled || !canRestoreRedactionEdit(state, "undo", id)}
        onClick={() => {
          commit((current) => restoreRedactionEdit(current, "undo", id));
          setSelected(-1);
        }}
        title="Ctrl+Z / ⌘Z"
      >
        {t("imageRedaction.undo")}
      </Button>
      <Button
        size="sm"
        disabled={disabled || !canRestoreRedactionEdit(state, "redo", id)}
        onClick={() => {
          commit((current) => restoreRedactionEdit(current, "redo", id));
          setSelected(-1);
        }}
        title="Ctrl+Shift+Z / ⌘⇧Z"
      >
        {t("imageRedaction.redo")}
      </Button>
      {selected >= 0 ? (
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            commit((current) =>
              changeRedactionStrokes(
                current,
                id,
                current.documents[id].strokes.filter(
                  (_, index) => index !== selected,
                ),
              ),
            );
            setSelected(-1);
          }}
        >
          {t("manualRedaction.deleteSelection")}
        </Button>
      ) : null}
      <Button
        size="sm"
        disabled={disabled || state.workspace.pages[0]?.id === id}
        onClick={onPreviousMask}
      >
        {t("manualRedaction.previousMask")}
      </Button>
      <Button size="sm" disabled={disabled} onClick={onPresets}>
        {t("manualRedaction.presets")}
      </Button>
    </div>
  );
}

export function RedactionZoomControls({
  form,
  pageId,
  zoom,
}: {
  form: RedactionWorkspaceController;
  pageId: string;
  zoom: number;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const setZoom = (value: number) =>
    form.commit((current) =>
      changeRedactionView(current, {
        pageViews: {
          ...current.workspace.view.pageViews,
          [pageId]: {
            ...(current.workspace.view.pageViews[pageId] ?? { x: 0, y: 0 }),
            zoom: value,
          },
        },
      }),
    );
  return (
    <div className={styles.zoomTools}>
      <span className={styles.hint}>
        {t(`manualRedaction.${form.state.documents[pageId].decision}`)}
      </span>
      <NumberField
        className={styles.number}
        variant="framed"
        ariaLabel={t("imageRedaction.zoom")}
        min={1}
        max={800}
        value={Math.round(zoom)}
        unit="%"
        onValueChange={setZoom}
        disabled={form.busy || form.drawing}
      />
      <Button
        size="sm"
        disabled={form.busy || form.drawing}
        onClick={() => setZoom(0)}
      >
        {t("codexFonts.fit")}
      </Button>
      <Button
        size="sm"
        disabled={form.busy || form.drawing}
        onClick={() => setZoom(100)}
      >
        100%
      </Button>
    </div>
  );
}
