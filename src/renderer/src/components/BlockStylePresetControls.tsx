import React from "react";
import { IconAlertTriangle, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockStylePresetSummary } from "../../../shared/blockStylePresets";
import {
  StylePresetEditorModal,
  type StylePresetDraft,
} from "./StylePresetEditorModal";

export function BlockStylePresetControls({
  canCreate,
  disabled,
  presets,
  onApply,
  onCreate,
}: {
  canCreate: boolean;
  disabled: boolean;
  presets: readonly BlockStylePresetSummary[];
  onApply: (presetId: string) => void;
  onCreate: (draft: StylePresetDraft) => boolean | Promise<boolean>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [createOpen, setCreateOpen] = React.useState(false);
  const pinned = presets.filter((preset) => preset.pinned);
  return (
    <section className="block-style-preset-controls">
      <div className="editor-group-head">
        <h3>{t("stylePresets.title")}</h3>
        {canCreate ? (
          <button
            type="button"
            className="style-preset-action ghost small"
            disabled={disabled}
            onClick={() => setCreateOpen(true)}
          >
            <IconPlus size={14} aria-hidden="true" />
            {t("stylePresets.createFromCurrent")}
          </button>
        ) : null}
      </div>
      {presets.length > 0 ? (
        <div className="block-style-preset-picker">
          <div className="block-style-preset-pinned">
            {pinned.map((preset) => (
              <PresetButton
                key={preset.id}
                disabled={disabled}
                preset={preset}
                onApply={onApply}
              />
            ))}
          </div>
          <select
            aria-label={t("stylePresets.all")}
            disabled={disabled}
            value=""
            onChange={(event) => {
              if (event.target.value) onApply(event.target.value);
            }}
          >
            <option value="">{t("stylePresets.all")}</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.missingFont ? "⚠ " : ""}
                {preset.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="muted-line">{t("stylePresets.empty")}</p>
      )}
      {createOpen ? (
        <StylePresetEditorModal
          onClose={() => setCreateOpen(false)}
          onSave={onCreate}
        />
      ) : null}
    </section>
  );
}

function PresetButton({
  disabled,
  preset,
  onApply,
}: {
  disabled: boolean;
  preset: BlockStylePresetSummary;
  onApply: (presetId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className={preset.missingFont ? "missing-font" : ""}
      disabled={disabled}
      title={
        preset.missingFont ? t("stylePresets.missingFontShort") : preset.name
      }
      onClick={() => onApply(preset.id)}
    >
      {preset.missingFont ? (
        <IconAlertTriangle size={13} aria-hidden="true" />
      ) : null}
      <span>{preset.name}</span>
    </button>
  );
}
