import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  FONT_WIDTH_SCALE_STEP,
  LETTER_SPACING_STEP_EM,
  LINE_HEIGHT_STEP,
  MAX_FONT_WIDTH_SCALE,
  MAX_LETTER_SPACING_EM,
  MAX_LINE_HEIGHT,
  MIN_FONT_WIDTH_SCALE,
  MIN_LETTER_SPACING_EM,
  MIN_LINE_HEIGHT,
  clampFontWidthScale,
  clampLetterSpacingEm,
  clampLineHeight,
} from "../../../shared/blockFormatValues";
import { NumberField } from "./ui/NumberField";

type BlockSpacingFieldsProps = {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

export function BlockSpacingFields({
  block,
  disabled,
  onUpdate,
}: BlockSpacingFieldsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const lineHeight = clampLineHeight(block.lineHeight);
  const letterSpacing = clampLetterSpacingEm(block.letterSpacing ?? 0);
  const fontWidthScale = clampFontWidthScale(block.fontWidthScale ?? 1);
  const labels = {
    lineHeight: t("format.lineHeight"),
    letterSpacing: t("format.letterSpacing"),
    fontWidth: t("format.fontWidth"),
  };
  const decreaseLabel = (label: string): string =>
    t("format.decreaseValue", { label });
  const increaseLabel = (label: string): string =>
    t("format.increaseValue", { label });

  return (
    <>
      <EditorNumberCell label={labels.lineHeight}>
        <NumberField
          variant="scrubber"
          ariaLabel={labels.lineHeight}
          decreaseLabel={decreaseLabel(labels.lineHeight)}
          increaseLabel={increaseLabel(labels.lineHeight)}
          min={MIN_LINE_HEIGHT}
          max={MAX_LINE_HEIGHT}
          step={LINE_HEIGHT_STEP}
          precision={2}
          value={lineHeight}
          disabled={disabled}
          onValueChange={(value) =>
            onUpdate({ lineHeight: clampLineHeight(value) })
          }
        />
      </EditorNumberCell>
      <EditorNumberCell label={labels.letterSpacing}>
        <NumberField
          variant="scrubber"
          ariaLabel={labels.letterSpacing}
          decreaseLabel={decreaseLabel(labels.letterSpacing)}
          increaseLabel={increaseLabel(labels.letterSpacing)}
          min={MIN_LETTER_SPACING_EM}
          max={MAX_LETTER_SPACING_EM}
          step={LETTER_SPACING_STEP_EM}
          precision={2}
          value={letterSpacing}
          disabled={disabled}
          unit="em"
          onValueChange={(value) =>
            onUpdate({ letterSpacing: clampLetterSpacingEm(value) })
          }
        />
      </EditorNumberCell>
      <EditorNumberCell label={labels.fontWidth}>
        <NumberField
          variant="scrubber"
          ariaLabel={labels.fontWidth}
          decreaseLabel={decreaseLabel(labels.fontWidth)}
          increaseLabel={increaseLabel(labels.fontWidth)}
          min={MIN_FONT_WIDTH_SCALE * 100}
          max={MAX_FONT_WIDTH_SCALE * 100}
          step={FONT_WIDTH_SCALE_STEP * 100}
          precision={0}
          value={fontWidthScale * 100}
          disabled={disabled}
          unit="%"
          onValueChange={(value) =>
            onUpdate({ fontWidthScale: clampFontWidthScale(value / 100) })
          }
        />
      </EditorNumberCell>
    </>
  );
}

function EditorNumberCell({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <div className="editor-format-number-cell">
      <span>{label}</span>
      {children}
    </div>
  );
}
