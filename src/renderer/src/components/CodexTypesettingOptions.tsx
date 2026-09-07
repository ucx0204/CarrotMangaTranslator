import React from "react";
import { useTranslation } from "react-i18next";
import type { CodexTypesettingPreferences } from "../../../shared/codexTypesettingTypes";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import { OptionRow, ToggleOptionRow } from "./TranslationOptionControls";
import styles from "./CodexTypesettingOptions.module.css";

type Props = {
  value: CodexTypesettingPreferences;
  onChange: (value: CodexTypesettingPreferences) => void;
  onEditFonts: () => void;
  onSelectPreset: (id: string) => Promise<void>;
};

export function CodexTypesettingOptions({
  value,
  onChange,
  onEditFonts,
  onSelectPreset,
}: Props) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.options}>
      <ToggleOptionRow
        label={t("regionOptions.erase")}
        pressed={value.eraseOriginal !== false}
        onChange={(eraseOriginal) => onChange({ ...value, eraseOriginal })}
      />
      <OptionRow
        label={t("codexTypesetting.sfxRendering")}
        value={value.sfxRendering ?? "image"}
        options={[
          { id: "image", label: t("codexTypesetting.sfxImage") },
          { id: "font", label: t("codexTypesetting.sfxFont") },
        ]}
        onChange={(sfxRendering) => onChange({ ...value, sfxRendering })}
      />
      <div className={styles.preset}>
        <Select
          ariaLabel={t("codexTypesetting.preset")}
          value={value.selectedPresetId}
          options={value.presets.map((preset) => ({
            value: preset.id,
            label: preset.name,
          }))}
          onValueChange={(id) => void onSelectPreset(id)}
        />
        <Button onClick={onEditFonts}>{t("codexFonts.edit")}</Button>
      </div>
    </div>
  );
}
