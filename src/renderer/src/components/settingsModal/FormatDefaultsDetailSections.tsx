import React from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_FONT_WIDTH_SCALE,
  MIN_FONT_WIDTH_SCALE,
} from "../../lib/blockFormatGeometry";
import type { BlockFormatDefaults } from "../../../../shared/settingsTypes";
import {
  DirectControlCaption,
  DirectSectionHeading,
  FormatSliderControl,
} from "../gatherText/GatherTextDirectFormatPrimitives";

type DetailSectionProps = {
  value: BlockFormatDefaults;
  onChange: (patch: Partial<BlockFormatDefaults>) => void;
};

export function FormatDefaultsColorSection({
  value,
  onChange,
}: DetailSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <div className="gather-direct-editor-section-head">
        <strong>{t("settings.format.color.title")}</strong>
        <button
          type="button"
          className="format-defaults-outline-toggle"
          aria-pressed={value.outlineEnabled}
          onClick={() => onChange({ outlineEnabled: !value.outlineEnabled })}
        >
          <span aria-hidden="true" />
          {t("settings.format.color.outlineEnabled")}
        </button>
      </div>
      <div className="gather-direct-editor-color-row">
        <DefaultColorControl
          label={t("settings.format.color.text")}
          value={value.textColor}
          onChange={(textColor) => onChange({ textColor })}
        />
        <DefaultColorControl
          label={t("settings.format.color.outline")}
          value={value.outlineColor}
          disabled={!value.outlineEnabled}
          onChange={(outlineColor) => onChange({ outlineColor })}
        />
        <FormatSliderControl
          label={t("gatherText.outlineWidth")}
          valueLabel={`${Math.round(value.outlineWidthScale * 100)}%`}
          min={0}
          max={2.5}
          step={0.1}
          value={value.outlineWidthScale}
          disabled={!value.outlineEnabled}
          onChange={(outlineWidthScale) => onChange({ outlineWidthScale })}
        />
      </div>
    </section>
  );
}

function DefaultColorControl({
  disabled = false,
  label,
  value,
  onChange,
}: {
  disabled?: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label
      className="gather-direct-color-control"
      aria-disabled={disabled || undefined}
    >
      <DirectControlCaption label={label} mixed={false} touched={false} />
      <span className="gather-direct-color-button">
        <span
          className="gather-direct-color-swatch"
          style={{ background: value }}
        />
        <span>{value.toUpperCase()}</span>
      </span>
      <input
        type="color"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function FormatDefaultsFineTuningSection({
  value,
  onChange,
}: DetailSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading title={t("gatherText.detailsSection")} />
      <div className="gather-direct-editor-slider-grid">
        <FormatSliderControl
          label={t("format.lineHeight")}
          valueLabel={value.lineHeight.toFixed(2)}
          min={0.8}
          max={3}
          step={0.05}
          value={value.lineHeight}
          onChange={(lineHeight) =>
            onChange({ lineHeight: round2(lineHeight) })
          }
        />
        <FormatSliderControl
          label={t("format.letterSpacing")}
          valueLabel={value.letterSpacing.toFixed(2)}
          min={-0.1}
          max={0.5}
          step={0.01}
          value={value.letterSpacing}
          onChange={(letterSpacing) =>
            onChange({ letterSpacing: round2(letterSpacing) })
          }
        />
        <FormatSliderControl
          label={t("format.fontWidth")}
          valueLabel={formatPercent(value.fontWidthScale)}
          min={MIN_FONT_WIDTH_SCALE}
          max={MAX_FONT_WIDTH_SCALE}
          step={0.01}
          value={value.fontWidthScale}
          onChange={(fontWidthScale) =>
            onChange({ fontWidthScale: round2(fontWidthScale) })
          }
        />
        <FormatSliderControl
          label={t("format.textOpacity")}
          valueLabel={formatPercent(value.textOpacity)}
          min={0}
          max={1}
          step={0.01}
          value={value.textOpacity}
          onChange={(textOpacity) => onChange({ textOpacity })}
        />
      </div>
    </section>
  );
}

function round2(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
