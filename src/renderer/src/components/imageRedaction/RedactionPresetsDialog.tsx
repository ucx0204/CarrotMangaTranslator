import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { ModalActionBar } from "../ui/ModalActionBar";
import { Button } from "../ui/Button";
import { ControlTooltip } from "../ui/ControlTooltip";
import { Field, TextField } from "../ui/Field";
import { Select } from "../ui/Select";
import { RedactionMaskCanvas } from "./RedactionMaskCanvas";
import { changeRedactionPresets, type RedactionCopySource } from "./redactionWorkspaceModel";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  source: RedactionCopySource;
  onApply: (source: RedactionCopySource) => void;
  onClose: () => void;
};
type PresetModel = ReturnType<typeof usePresetModel>;

export function RedactionPresetsDialog(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = usePresetModel(props);
  return (
    <Modal title={t("manualRedaction.presets")} size="md" onClose={props.onClose}
      footer={<ModalActionBar actions={<>
        <Button onClick={props.onClose}>{t("manualRedaction.close")}</Button>
        <Button variant="primary" disabled={!model.preset}
          onClick={() => { if (model.preset) props.onApply(model.preset); }}>
          {t("manualRedaction.usePreset")}
        </Button>
      </>} />}
    >
      <PresetSaveControls model={model} />
      <Select ariaLabel={t("manualRedaction.savedPresets")}
        value={model.selected} disabled={!model.presets.length}
        options={model.presets.map((item) => ({ value: item.id, label: item.name }))}
        onValueChange={(value) => { model.setSelected(value); model.setDeleting(false); }} />
      <PresetPreview model={model} form={props.form} />
      {props.form.error ? <p role="alert" className={styles.inlineError}>{props.form.error}</p> : null}
    </Modal>
  );
}

function usePresetModel({ form, source }: Props) {
  const presets = form.state.workspace.presets;
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState(presets[0]?.id ?? "");
  const [deleting, setDeleting] = React.useState(false);
  const preset = presets.find((item) => item.id === selected);
  const canSave = Boolean(name.trim() && source.strokes.length && presets.length < 30);
  const save = () => {
    if (!canSave) return;
    const entry = { ...source, id: crypto.randomUUID(), name: name.trim() };
    form.commit((current) => changeRedactionPresets(current, [...current.workspace.presets, entry]));
    setSelected(entry.id);
    setName("");
  };
  const remove = () => {
    if (!preset) return;
    if (!deleting) { setDeleting(true); return; }
    form.commit((current) => changeRedactionPresets(current,
      current.workspace.presets.filter((item) => item.id !== preset.id)));
    setSelected(presets.find((item) => item.id !== preset.id)?.id ?? "");
    setDeleting(false);
  };
  return { presets, name, setName, selected, setSelected, deleting, setDeleting, preset, canSave, save, remove };
}

function PresetSaveControls({ model }: { model: PresetModel }): React.JSX.Element {
  const { t } = useTranslation("components");
  return <>
    <Field label={t("manualRedaction.presetName")}>
      <TextField value={model.name} maxLength={80}
        onChange={(event) => model.setName(event.target.value)}
        placeholder={t("manualRedaction.presetNameHint")} />
    </Field>
    <ControlTooltip content={t("manualRedaction.presetHint")} placement="bottom">
      <Button onClick={model.save} disabled={!model.canSave}>{t("manualRedaction.savePreset")}</Button>
    </ControlTooltip>
  </>;
}

function PresetPreview({ model, form }: { model: PresetModel; form: RedactionWorkspaceController }): React.JSX.Element {
  const { t } = useTranslation("components");
  const { preset, deleting, remove } = model;
  if (!preset) return <p>{t("manualRedaction.noPresets")}</p>;
  return <div className={styles.previewPanel}>
    <span>{preset.width} × {preset.height} · {t("manualRedaction.strokeCount", { count: preset.strokes.length })}</span>
    <div className={styles.presetPreview} style={{
      width: Math.min(220, 180 * preset.width / preset.height),
      height: Math.min(180, 220 * preset.height / preset.width),
    }}>
      <RedactionMaskCanvas thumbnail width={preset.width} height={preset.height}
        strokes={preset.strokes} onFailure={form.report} />
    </div>
    <Button variant={deleting ? "danger" : "secondary"} onClick={remove}>
      {t(deleting ? "manualRedaction.confirmDeletePreset" : "manualRedaction.deletePreset")}
    </Button>
  </div>;
}
