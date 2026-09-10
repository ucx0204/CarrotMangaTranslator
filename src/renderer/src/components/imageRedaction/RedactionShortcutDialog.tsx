import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import { Field, TextField } from "../ui/Field";
import { CheckboxField } from "../ui/CheckboxField";
import { changeRedactionPreferences } from "./redactionWorkspaceModel";
import { validRedactionNavigationKeys } from "./redactionKeyboard";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import styles from "./RedactionWorkspace.module.css";

type Props = { form: RedactionWorkspaceController; onClose: () => void };
type ShortcutModel = ReturnType<typeof useShortcutModel>;

export function RedactionShortcutDialog(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useShortcutModel(props);
  return <Modal title={t("manualRedaction.shortcuts")} size="md" onClose={props.onClose}
    footer={<ControlTooltip content={t("manualRedaction.shortcutScope")} placement="top">
      <Button variant="primary" disabled={!model.valid} onClick={model.save}>
        {t("manualRedaction.saveAndClose")}
      </Button>
    </ControlTooltip>}
  >
    <ShortcutList model={model} />
    <ShortcutFields model={model} form={props.form} />
  </Modal>;
}

function useShortcutModel({ form, onClose }: Props) {
  const preferences = form.state.workspace.preferences;
  const [previous, setPrevious] = React.useState(preferences.previousKey);
  const [next, setNext] = React.useState(preferences.nextKey);
  const valid = validRedactionNavigationKeys(previous, next);
  const save = () => {
    if (!valid) return;
    form.commit((current) => changeRedactionPreferences(current, { previousKey: previous, nextKey: next }));
    onClose();
  };
  return { preferences, previous, setPrevious, next, setNext, valid, save };
}

function ShortcutList({ model }: { model: ShortcutModel }): React.JSX.Element {
  const { t } = useTranslation("components");
  const letters = model.preferences.letterShortcuts
    ? `${model.previous.toUpperCase() || "—"} / ${model.next.toUpperCase() || "—"} · ` : "";
  const rows = [
    [`${letters}← / →`, "keysNavigate"],
    ["Enter", "keysConfirm"],
    ["Shift+Enter", "keysDefer"],
    ["Ctrl+Enter / ⌘Enter", "keysContinue"],
    ["R / B / E / V / H", "keysTools"],
    ["Space + Drag", "keysPan"],
    ["[ / ]", "keysSize"],
    ["Ctrl+Z / ⌘Z", "keysUndo"],
    ["Ctrl+Shift+Z / ⌘⇧Z", "keysRedo"],
    ["F / 1", "keysZoom"],
  ];
  return <dl className={styles.shortcutGrid}>
    {rows.map(([keys, label]) => <React.Fragment key={label}>
      <dt><kbd>{keys}</kbd></dt><dd>{t(`manualRedaction.${label}`)}</dd>
    </React.Fragment>)}
  </dl>;
}

function ShortcutFields({ model, form }: { model: ShortcutModel; form: RedactionWorkspaceController }): React.JSX.Element {
  const { t } = useTranslation("components");
  return <>
    <CheckboxField checked={model.preferences.letterShortcuts}
      onCheckedChange={(letterShortcuts) => form.commit((current) => changeRedactionPreferences(current, { letterShortcuts }))}
      label={t("manualRedaction.letterShortcuts")} />
    <div className={styles.previewPair}>
      <Field label={t("manualRedaction.previousKey")}>
        <TextField maxLength={1} value={model.previous}
          onChange={(event) => model.setPrevious(event.target.value.toLowerCase())} />
      </Field>
      <Field label={t("manualRedaction.nextKey")}>
        <TextField maxLength={1} value={model.next}
          onChange={(event) => model.setNext(event.target.value.toLowerCase())} />
      </Field>
    </div>
    {!model.valid ? <p role="alert" className={styles.inlineError}>{t("manualRedaction.keyConflict")}</p> : null}
    <CheckboxField checked={model.preferences.keepZoom}
      onCheckedChange={(keepZoom) => form.commit((current) => changeRedactionPreferences(current, { keepZoom }))}
      label={t("manualRedaction.keepZoom")} />
  </>;
}
