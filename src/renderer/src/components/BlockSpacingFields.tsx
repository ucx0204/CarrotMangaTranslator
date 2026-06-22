import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import { FieldSlider } from "./ui";

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
  const lineHeight = clampLineHeight(block.lineHeight);
  const letterSpacing = clampLetterSpacing(block.letterSpacing);
  return (
    <>
      <FieldSlider
        label="줄 간격"
        valueLabel={lineHeight.toFixed(2)}
        min={0.8}
        max={3}
        step={0.05}
        value={lineHeight}
        disabled={disabled}
        onChange={(event) =>
          onUpdate({
            lineHeight: clampLineHeight(Number(event.target.value)),
          })
        }
      />
      <FieldSlider
        label="자간"
        valueLabel={letterSpacing.toFixed(2)}
        min={-0.1}
        max={0.5}
        step={0.01}
        value={letterSpacing}
        disabled={disabled}
        onChange={(event) =>
          onUpdate({
            letterSpacing: clampLetterSpacing(Number(event.target.value)),
          })
        }
      />
    </>
  );
}

function clampLineHeight(value: number): number {
  if (!Number.isFinite(value)) {
    return 1.18;
  }
  return Math.round(Math.max(0.8, Math.min(3, value)) * 100) / 100;
}

function clampLetterSpacing(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.max(-0.1, Math.min(0.5, value)) * 100) / 100;
}
