import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { ModalActionBar } from "../ui/ModalActionBar";
import { Button } from "../ui/Button";
import { Field, TextField } from "../ui/Field";
import { Select } from "../ui/Select";
import { RedactionMaskCanvas } from "./RedactionMaskCanvas";
import { changeRedactionPresets, type RedactionCopySource } from "./redactionWorkspaceModel";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import styles from "./RedactionWorkspace.module.css";

export function RedactionPresetsDialog({ form, source, onApply, onClose }: {
  form: RedactionWorkspaceController; source: RedactionCopySource;
  onApply: (source: RedactionCopySource) => void; onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const presets = form.state.workspace.presets;
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState(presets[0]?.id ?? "");
  const [deleting, setDeleting] = React.useState(false);
  const preset = presets.find((item) => item.id === selected);
  const save = () => {
    if (!name.trim() || !source.strokes.length || presets.length >= 30) return;
    const entry = { ...source, id: crypto.randomUUID(), name: name.trim() };
    form.commit((current) => changeRedactionPresets(current, [...current.workspace.presets, entry]));
    setSelected(entry.id); setName("");
  };
  const remove = () => {
    if (!preset) return;
    if (!deleting) { setDeleting(true); return; }
    form.commit((current) => changeRedactionPresets(current, current.workspace.presets.filter((item) => item.id !== preset.id)));
    setSelected(presets.find((item) => item.id !== preset.id)?.id ?? ""); setDeleting(false);
  };
  return <Modal title={t("manualRedaction.presets")} size="md" onClose={onClose}
    footer={<ModalActionBar actions={<><Button onClick={onClose}>{t("manualRedaction.close")}</Button><Button variant="primary" disabled={!preset} onClick={() => { if (preset) onApply(preset); }}>{t("manualRedaction.usePreset")}</Button></>} />}>
    <p className={styles.hint}>{t("manualRedaction.presetHint")}</p>
    <Field label={t("manualRedaction.presetName")}>
      <TextField value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder={t("manualRedaction.presetNameHint")} />
    </Field>
    <Button onClick={save} disabled={!name.trim() || !source.strokes.length || presets.length >= 30}>{t("manualRedaction.savePreset")}</Button>
    <Select ariaLabel={t("manualRedaction.savedPresets")} value={selected} disabled={!presets.length}
      options={presets.map((item) => ({ value: item.id, label: item.name }))}
      onValueChange={(value) => { setSelected(value); setDeleting(false); }} />
    {preset ? <div className={styles.previewPanel}>
      <span>{preset.width} × {preset.height} · {t("manualRedaction.strokeCount", { count: preset.strokes.length })}</span>
      <div className={styles.presetPreview} style={{ width: Math.min(220, 180 * preset.width / preset.height), height: Math.min(180, 220 * preset.height / preset.width) }}>
        <RedactionMaskCanvas thumbnail width={preset.width} height={preset.height} strokes={preset.strokes} onFailure={form.report} />
      </div>
      <Button variant={deleting ? "danger" : "secondary"} onClick={remove}>{t(deleting ? "manualRedaction.confirmDeletePreset" : "manualRedaction.deletePreset")}</Button>
    </div> : <p>{t("manualRedaction.noPresets")}</p>}
  </Modal>;
}
