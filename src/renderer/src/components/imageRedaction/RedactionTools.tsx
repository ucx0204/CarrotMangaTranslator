import React from "react";
import { useTranslation } from "react-i18next";
import {
  IconSquare,
  IconBrush,
  IconEraser,
  IconPointer,
  IconHandMove,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconTrash,
  IconCircle,
  IconArrowsMaximize,
} from "@tabler/icons-react";
import { Button } from "../ui/Button";
import { NumberField } from "../ui/NumberField";
import { ControlTooltip } from "../ui/ControlTooltip";
import { useRedactionShortcutLabels } from "./useRedactionShortcutLabels";
import { RedactionIconButton } from "./RedactionIconButton";
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

type Props = {
  form: RedactionWorkspaceController;
  selected: number;
  setSelected: (index: number) => void;
};
const TOOLS = [
  { id: "rectangle", Icon: IconSquare },
  { id: "brush", Icon: IconBrush },
  { id: "erase", Icon: IconEraser },
  { id: "select", Icon: IconPointer },
  { id: "pan", Icon: IconHandMove },
] as const;
export function RedactionTools(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { form } = props;
  const tool = form.state.workspace.preferences.tool;
  return (
    <div
      className={styles.tools}
      role="group"
      aria-label={t("manualRedaction.tool")}
    >
      <div className={styles.toolGroup}>
        {TOOLS.map(({ id, Icon }) => (
          <RedactionIconButton
            key={id}
            label={t(`manualRedaction.tool_${id}`)}
            aria-pressed={tool === id}
            disabled={form.busy || form.drawing}
            onClick={() =>
              form.commit((current) =>
                changeRedactionPreferences(current, { tool: id }),
              )
            }
          >
            <Icon size={18} aria-hidden="true" />
          </RedactionIconButton>
        ))}
      </div>
      <RedactionEditHistory {...props} />
      {tool === "brush" || tool === "erase" ? (
        <BrushOptions form={form} />
      ) : null}
    </div>
  );
}
function RedactionEditHistory({
  form,
  selected,
  setSelected,
}: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { state, commit } = form;
  const id = state.workspace.view.currentId;
  const keys = useRedactionShortcutLabels(state.workspace.preferences);
  const disabled = form.busy || form.drawing;
  return (
    <div className={styles.toolGroup}>
      {(["undo", "redo"] as const).map((direction) => {
        const Icon =
          direction === "undo" ? IconArrowBackUp : IconArrowForwardUp;
        return (
          <RedactionIconButton
            key={direction}
            label={t(`imageRedaction.${direction}`)}
            hint={`${t(`imageRedaction.${direction}`)} · ${keys(direction)}`}
            disabled={
              disabled || !canRestoreRedactionEdit(state, direction, id)
            }
            onClick={() => {
              commit((current) => restoreRedactionEdit(current, direction, id));
              setSelected(-1);
            }}
          >
            <Icon size={18} aria-hidden="true" />
          </RedactionIconButton>
        );
      })}
      {selected >= 0 ? (
        <RedactionIconButton
          label={t("manualRedaction.deleteSelection")}
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
          <IconTrash size={18} aria-hidden="true" />
        </RedactionIconButton>
      ) : null}
    </div>
  );
}
function BrushOptions({
  form,
}: {
  form: RedactionWorkspaceController;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { preferences } = form.state.workspace;
  const disabled = form.busy || form.drawing;
  return (
    <div className={styles.toolGroup}>
      {(["round", "square"] as const).map((shape) => {
        const Icon = shape === "round" ? IconCircle : IconSquare;
        return (
          <RedactionIconButton
            key={shape}
            label={t(`imageRedaction.${shape}`)}
            aria-pressed={preferences.shape === shape}
            disabled={disabled}
            onClick={() =>
              form.commit((current) =>
                changeRedactionPreferences(current, { shape }),
              )
            }
          >
            <Icon size={16} aria-hidden="true" />
          </RedactionIconButton>
        );
      })}
      <NumberField
        className={styles.number}
        variant="framed"
        ariaLabel={t("imageRedaction.size")}
        min={1}
        max={1000}
        value={preferences.size}
        unit="px"
        disabled={disabled}
        onValueChange={(size) =>
          form.commit((current) =>
            changeRedactionPreferences(current, { size }),
          )
        }
      />
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
  const disabled = form.busy || form.drawing;
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
      <NumberField
        className={styles.number}
        variant="framed"
        ariaLabel={t("imageRedaction.zoom")}
        min={1}
        max={800}
        value={Math.round(zoom)}
        unit="%"
        onValueChange={setZoom}
        disabled={disabled}
      />
      <RedactionIconButton
        label={t("codexFonts.fit")}
        disabled={disabled}
        onClick={() => setZoom(0)}
      >
        <IconArrowsMaximize size={18} aria-hidden="true" />
      </RedactionIconButton>
      <ControlTooltip
        content={t("manualRedaction.keysZoom")}
        placement="bottom"
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => setZoom(100)}
        >
          100%
        </Button>
      </ControlTooltip>
    </div>
  );
}
