import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  FONT_SIZE_STEP_PX,
  MAX_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
} from "../../../shared/blockFormatValues";
import { clampFontSize } from "./editorPanelUtils";
import { CheckboxField } from "./ui/CheckboxField";
import { NumberField } from "./ui/NumberField";

export function EditorFontSizeRow({
  autoFitMixed,
  autoFitText,
  disabled,
  fontSizeMixed,
  fontSizePx,
  onAdjust,
  onUpdate,
}: {
  autoFitMixed: boolean;
  autoFitText: boolean;
  disabled: boolean;
  fontSizeMixed: boolean;
  fontSizePx: number;
  onAdjust: (adjustment: -1 | 1) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const autoFitUniformlyEnabled = autoFitText && !autoFitMixed;
  const updateFontSize = (value: number) =>
    onUpdate({
      fontSizePx: clampFontSize(value),
      autoFitText: false,
      fontSizeIntent: "manual",
    });
  return (
    <div className="editor-font-size-row">
      <div className="editor-format-number-cell">
        <span>{t("format.size")}</span>
        <NumberField
          variant="scrubber"
          ariaLabel={t("format.fontSizeValue")}
          decreaseLabel={t("format.fontSizeDecrease")}
          increaseLabel={t("format.fontSizeIncrease")}
          min={MIN_FONT_SIZE_PX}
          max={MAX_FONT_SIZE_PX}
          step={FONT_SIZE_STEP_PX}
          precision={1}
          value={fontSizePx}
          mixed={fontSizeMixed}
          disabled={disabled}
          inputDisabled={autoFitUniformlyEnabled}
          scrubDisabled={autoFitUniformlyEnabled}
          unit="px"
          onStep={onAdjust}
          onValueChange={updateFontSize}
        />
      </div>
      <CheckboxField
        className="inline-toggle editor-font-size-auto"
        title={t("format.autoFitTitle")}
        label={t("format.auto")}
        checked={autoFitText}
        indeterminate={autoFitMixed}
        disabled={disabled}
        onCheckedChange={(checked) => {
          const nextChecked = autoFitMixed ? true : checked;
          onUpdate(
            nextChecked
              ? { autoFitText: true, fontSizeIntent: "manual" }
              : {
                  autoFitText: false,
                  fontSizeIntent: "manual",
                  fontSizePx: clampFontSize(fontSizePx),
                },
          );
        }}
      />
    </div>
  );
}
