import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GatherTextDirectFormatModel,
  GatherTextDirectFormatPatch,
} from "../../lib/gatherTextDirectFormatModel";
import {
  BlockFormatControlCaption,
  BlockFormatSectionHeading,
  FormatSliderControl,
} from "../blockFormat/BlockFormatPrimitives";
import {
  clampDirectFormatValue,
  hasDirectFormatField,
  resolveControlState,
  resolvePreviewValue,
} from "./gatherTextDirectFormatUi";

export {
  BlockFormatControlCaption as DirectControlCaption,
  BlockFormatSectionHeading as DirectSectionHeading,
};

export type DirectSliderField =
  | "lineHeight"
  | "letterSpacing"
  | "fontWidthScale"
  | "outlineWidthScale"
  | "rotationDeg"
  | "textOpacity";

export function DirectSliderControl<Field extends DirectSliderField>({
  field,
  label,
  min,
  max,
  step,
  formatValue,
  disabled,
  model,
  patch,
  onChange,
}: {
  field: Field;
  label: string;
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
  disabled: boolean;
  model: GatherTextDirectFormatModel;
  patch: GatherTextDirectFormatPatch;
  onChange: (value: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = resolveControlState(model.values, patch, field);
  const touched = hasDirectFormatField(patch, field);
  const value = resolvePreviewValue(model, patch, field);
  const clampedValue = clampDirectFormatValue(value, min, max);
  const mixed = state.kind === "mixed" && !touched;
  return (
    <FormatSliderControl
      label={label}
      valueLabel={mixed ? t("gatherText.mixedValue") : formatValue(value)}
      min={min}
      max={max}
      step={step}
      value={clampedValue}
      disabled={disabled}
      mixed={mixed}
      touched={touched}
      onChange={onChange}
    />
  );
}
