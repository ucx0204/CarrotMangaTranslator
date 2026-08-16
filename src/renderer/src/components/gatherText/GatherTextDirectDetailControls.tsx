import React from "react";
import { useTranslation } from "react-i18next";
import {
  FONT_WIDTH_SCALE_STEP,
  LETTER_SPACING_STEP_EM,
  LINE_HEIGHT_STEP,
  MAX_LETTER_SPACING_EM,
  MAX_LINE_HEIGHT,
  MIN_LETTER_SPACING_EM,
  MIN_LINE_HEIGHT,
} from "../../../../shared/blockFormatValues";
import {
  MAX_TEXT_OUTLINE_WIDTH_PX,
  MIN_TEXT_OUTLINE_WIDTH_PX,
  TEXT_OUTLINE_WIDTH_STEP_PX,
} from "../../../../shared/textOutline";
import {
  MAX_FONT_WIDTH_SCALE,
  MIN_FONT_WIDTH_SCALE,
} from "../../lib/blockFormatGeometry";
import type {
  GatherTextDirectFormatModel,
  GatherTextDirectFormatPatch,
} from "../../lib/gatherTextDirectFormatModel";
import {
  DirectControlCaption,
  DirectNumberControl,
  DirectSectionHeading,
  DirectSliderControl,
  type DirectNumberField,
  type DirectSliderField,
} from "./GatherTextDirectFormatPrimitives";
import { TextWrappingSelect } from "../TextWrappingSelect";
import {
  hasDirectFormatField,
  resolveControlState,
  resolvePreviewValue,
  type DirectChangeHandler,
} from "./gatherTextDirectFormatUi";

type DetailControlProps = {
  disabled: boolean;
  model: GatherTextDirectFormatModel;
  patch: GatherTextDirectFormatPatch;
  onChange: DirectChangeHandler;
};

export function GatherTextDirectDetailControls(
  props: DetailControlProps,
): React.JSX.Element {
  return (
    <>
      <ColorControls {...props} />
      <AdvancedControls {...props} />
    </>
  );
}

function ColorControls({
  disabled,
  model,
  patch,
  onChange,
}: DetailControlProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading title={t("gatherText.colorSection")} />
      <div className="gather-direct-editor-color-row">
        <ColorSwatchControl
          field="textColor"
          label={t("format.textColor")}
          fallback="#111111"
          {...{ disabled, model, patch }}
          onChange={(value) => onChange("textColor", value)}
        />
        <ColorSwatchControl
          field="outlineColor"
          label={t("format.outline")}
          fallback="#ffffff"
          {...{ disabled, model, patch }}
          onChange={(value) => onChange("outlineColor", value)}
        />
        <OutlineWidthControl {...{ disabled, model, patch, onChange }} />
      </div>
    </section>
  );
}

function OutlineWidthControl({
  disabled,
  model,
  patch,
  onChange,
}: DetailControlProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <DirectNumberControl
      field="outlineWidthPx"
      label={t("gatherText.outlineWidth")}
      max={MAX_TEXT_OUTLINE_WIDTH_PX}
      min={MIN_TEXT_OUTLINE_WIDTH_PX}
      precision={1}
      step={TEXT_OUTLINE_WIDTH_STEP_PX}
      unit="px"
      {...{ disabled, model, patch }}
      onChange={(value) => onChange("outlineWidthPx", value)}
    />
  );
}

function AdvancedControls({
  disabled,
  model,
  patch,
  onChange,
}: DetailControlProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const numberConfigs = createAdvancedNumberConfigs(t);
  const sliderConfigs = createAdvancedSliderConfigs(t);
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading
        title={t("gatherText.detailsSection")}
        description={t("gatherText.detailsHint")}
      />
      <div className="gather-direct-editor-slider-grid">
        <WordBreakControl {...{ disabled, model, patch, onChange }} />
        {numberConfigs.map((config) => (
          <DirectNumberControl
            key={config.field}
            {...config}
            {...{ disabled, model, patch }}
            onChange={(value) => onChange(config.field, value)}
          />
        ))}
        {sliderConfigs.map((config) => (
          <DirectSliderControl
            key={config.field}
            {...config}
            {...{ disabled, model, patch }}
            onChange={(value) => onChange(config.field, value)}
          />
        ))}
      </div>
    </section>
  );
}

function WordBreakControl({
  disabled,
  model,
  patch,
  onChange,
}: DetailControlProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = resolveControlState(model.values, patch, "wordBreak");
  const touched = hasDirectFormatField(patch, "wordBreak");
  return (
    <label
      className="gather-direct-select-control"
      data-touched={touched || undefined}
    >
      <DirectControlCaption
        label={t("format.wordBreak.label")}
        mixed={state.kind === "mixed"}
        touched={touched}
      />
      <TextWrappingSelect
        ariaLabel={t("format.wordBreak.label")}
        value={resolvePreviewValue(model, patch, "wordBreak")}
        mixed={state.kind === "mixed" && !touched}
        disabled={disabled}
        onChange={(wordBreak) => onChange("wordBreak", wordBreak)}
      />
    </label>
  );
}

type AdvancedSliderConfig = {
  field: DirectSliderField;
  label: string;
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
};

type AdvancedNumberConfig = {
  field: DirectNumberField;
  label: string;
  min: number;
  max: number;
  step: number;
  precision: number;
  unit?: string;
  displayScale?: number;
};

function createAdvancedNumberConfigs(
  t: ReturnType<typeof useTranslation<"components">>["t"],
): AdvancedNumberConfig[] {
  return [
    {
      field: "lineHeight",
      label: t("format.lineHeight"),
      min: MIN_LINE_HEIGHT,
      max: MAX_LINE_HEIGHT,
      step: LINE_HEIGHT_STEP,
      precision: 2,
    },
    {
      field: "letterSpacing",
      label: t("format.letterSpacing"),
      min: MIN_LETTER_SPACING_EM,
      max: MAX_LETTER_SPACING_EM,
      step: LETTER_SPACING_STEP_EM,
      precision: 2,
      unit: "em",
    },
    {
      field: "fontWidthScale",
      label: t("format.fontWidth"),
      min: MIN_FONT_WIDTH_SCALE,
      max: MAX_FONT_WIDTH_SCALE,
      step: FONT_WIDTH_SCALE_STEP,
      precision: 0,
      unit: "%",
      displayScale: 100,
    },
  ];
}

function createAdvancedSliderConfigs(
  t: ReturnType<typeof useTranslation<"components">>["t"],
): AdvancedSliderConfig[] {
  return [
    {
      field: "rotationDeg",
      label: t("format.rotation"),
      min: -180,
      max: 180,
      step: 1,
      formatValue: (value) => `${Math.round(value)}°`,
    },
    {
      field: "textOpacity",
      label: t("format.textOpacity"),
      min: 0,
      max: 1,
      step: 0.01,
      formatValue: formatPercent,
    },
  ];
}

function ColorSwatchControl<Field extends "textColor" | "outlineColor">({
  field,
  label,
  fallback,
  disabled,
  model,
  patch,
  onChange,
}: {
  field: Field;
  label: string;
  fallback: string;
  disabled: boolean;
  model: GatherTextDirectFormatModel;
  patch: GatherTextDirectFormatPatch;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = resolveControlState(model.values, patch, field);
  const touched = hasDirectFormatField(patch, field);
  const effective = resolvePreviewValue(model, patch, field) ?? fallback;
  const valueLabel =
    state.kind === "mixed" && !touched
      ? t("gatherText.mixedValue")
      : effective.toUpperCase();
  return (
    <label
      className="gather-direct-color-control"
      data-touched={touched || undefined}
    >
      <DirectControlCaption label={label} mixed={false} touched={touched} />
      <span className="gather-direct-color-button">
        <span
          className="gather-direct-color-swatch"
          style={{ background: effective }}
        />
        <span>{valueLabel}</span>
      </span>
      <input
        type="color"
        aria-label={label}
        value={effective}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
