import type React from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "./ui/SegmentedControl";
import { ToggleOptionRow } from "./TranslationOptionControls";
import styles from "./ImageTranslationOptions.module.css";

export type ImageTranslationChoices = {
  output: "text" | "image";
  eraseOriginal: boolean;
  invertColors?: boolean;
  eraseEngine?: "default" | "codex";
};

export function ImageTranslationOptions({
  value,
  onChange,
  available,
  disabled,
  allowInvertColors = false,
}: {
  value: ImageTranslationChoices;
  onChange: (value: ImageTranslationChoices) => void;
  available: boolean;
  disabled?: boolean;
  allowInvertColors?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <SegmentedControl
        singleRow
        ariaLabel={t("regionOptions.output")}
        value={value.output}
        disabled={disabled}
        options={[
          { id: "text", label: t("regionOptions.text") },
          {
            id: "image",
            label: t("regionOptions.image"),
            disabled: !available,
          },
        ]}
        onChange={(output) => onChange({ ...value, output })}
      />
      <div className={styles.toggles}>
        <ToggleOptionRow
          label={t("regionOptions.erase")}
          pressed={value.eraseOriginal}
          disabled={disabled}
          onChange={(eraseOriginal) => onChange({ ...value, eraseOriginal })}
        />
        {allowInvertColors && value.output === "image" ? (
          <ToggleOptionRow
            label={t("regionOptions.invertColors")}
            pressed={value.invertColors === true}
            disabled={disabled || !available}
            onChange={(invertColors) => onChange({ ...value, invertColors })}
          />
        ) : null}
      </div>
      {allowInvertColors && value.output === "image" && value.invertColors ? (
        <p className="muted-line modal-note">
          {t("regionOptions.invertColorsHint")}
        </p>
      ) : null}
      {value.output === "text" && value.eraseOriginal ? (
        <SegmentedControl
          singleRow
          ariaLabel={t("settings.image.localErasure")}
          value={value.eraseEngine ?? "default"}
          disabled={disabled}
          options={[
            { id: "default", label: t("imageOptions.default") },
            { id: "codex", label: "Codex", disabled: !available },
          ]}
          onChange={(eraseEngine) => onChange({ ...value, eraseEngine })}
        />
      ) : null}
      {!available ? (
        <p className="muted-line modal-note">{t("imageOptions.connect")}</p>
      ) : null}
    </>
  );
}
