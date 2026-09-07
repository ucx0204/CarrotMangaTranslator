import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { CodexTypesettingPreferences } from "../../../shared/codexTypesettingTypes";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Field";
import { Select } from "./ui/Select";
import { ConfirmModal } from "./ConfirmModal";
import { CodexFontPagePreview } from "./CodexFontPagePreview";
import { CodexFontPresetFields } from "./CodexFontPresetFields";
import styles from "./CodexFontEditor.module.css";

export type CodexFontEditorProps = {
  value: CodexTypesettingPreferences;
  onChange: (value: CodexTypesettingPreferences) => void;
  pages: MangaPage[];
  currentPageId?: string | null;
  flush: () => Promise<boolean>;
  onSelectPreset: (id: string) => Promise<void>;
  error: boolean;
  busy: boolean;
  onClose: () => void;
};

export function CodexFontEditor(props: CodexFontEditorProps) {
  const { t } = useTranslation("components");
  const close = async () => {
    if (await props.flush()) props.onClose();
  };
  return (
    <Modal
      title={t("codexFonts.title")}
      size="xl"
      width="min(1280px, 100%)"
      maxHeight="900px"
      fillHeight
      bodyLayout="flex"
      bodyClassName={styles.body}
      onClose={() => void close()}
      footer={
        <div className={styles.footer}>
          <CodexPreferencesSaveError error={props.error} retry={props.flush} />
          <Button onClick={() => void close()} disabled={props.busy}>
            {t("common.close")}
          </Button>
        </div>
      }
    >
      <div className={styles.layout}>
        <CodexFontPagePreview
          pages={props.pages}
          currentPageId={props.currentPageId}
        />
        <PresetEditor {...props} />
      </div>
    </Modal>
  );
}

function PresetEditor({
  value,
  onChange,
  onSelectPreset,
}: CodexFontEditorProps) {
  const { t } = useTranslation("components");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const preset =
    value.presets.find((item) => item.id === value.selectedPresetId) ??
    value.presets[0];
  return (
    <section className={styles.editor}>
      <PresetToolbar
        value={value}
        onChange={onChange}
        onSelectPreset={onSelectPreset}
        onDelete={() => setConfirmDelete(true)}
      />
      <TextField
        label={t("codexTypesetting.presetName")}
        value={preset.name}
        maxLength={100}
        onChange={(event) =>
          onChange({
            ...value,
            presets: value.presets.map((item) =>
              item.id === preset.id
                ? { ...item, name: event.target.value }
                : item,
            ),
          })
        }
      />
      <CodexFontPresetFields
        key={preset.id}
        preset={preset}
        onChange={(next) =>
          onChange({
            ...value,
            presets: value.presets.map((item) =>
              item.id === next.id ? next : item,
            ),
          })
        }
      />
      {confirmDelete ? (
        <ConfirmModal
          title={t("codexFonts.deletePreset")}
          message={preset.name}
          confirmLabel={t("codexTypesetting.remove")}
          confirmVariant="danger"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            const presets = value.presets.filter(
              (item) => item.id !== preset.id,
            );
            onChange({ ...value, presets, selectedPresetId: presets[0].id });
            setConfirmDelete(false);
          }}
        />
      ) : null}
    </section>
  );
}

export function CodexPreferencesSaveError({
  error,
  retry,
}: {
  error: boolean;
  retry: () => Promise<boolean>;
}) {
  const { t } = useTranslation("components");
  return error ? (
    <div className={styles.notice} role="alert">
      <span>{t("codexFonts.saveFailed")}</span>
      <Button size="sm" onClick={() => void retry()}>
        {t("codexFonts.retry")}
      </Button>
    </div>
  ) : null;
}

function PresetToolbar({
  value,
  onChange,
  onSelectPreset,
  onDelete,
}: Pick<CodexFontEditorProps, "value" | "onChange" | "onSelectPreset"> & {
  onDelete: () => void;
}) {
  const { t } = useTranslation("components");
  const preset =
    value.presets.find((item) => item.id === value.selectedPresetId) ??
    value.presets[0];
  return (
    <div className={styles.toolbar}>
      <Select
        ariaLabel={t("codexTypesetting.preset")}
        value={preset.id}
        options={value.presets.map((item) => ({
          value: item.id,
          label: item.name,
        }))}
        onValueChange={(id) => void onSelectPreset(id)}
      />
      <Button
        size="sm"
        disabled={value.presets.length >= 30}
        onClick={() => {
          const copy = {
            ...structuredClone(preset),
            id: crypto.randomUUID(),
            name: `${preset.name.slice(0, 85)} ${t("codexFonts.copySuffix")}`,
          };
          onChange({
            ...value,
            presets: [...value.presets, copy],
            selectedPresetId: copy.id,
          });
        }}
      >
        {t("codexTypesetting.copyPreset")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={value.presets.length <= 1}
        onClick={onDelete}
      >
        {t("codexTypesetting.remove")}
      </Button>
    </div>
  );
}
