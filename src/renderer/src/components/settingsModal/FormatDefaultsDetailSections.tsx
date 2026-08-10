import React from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_FONT_WIDTH_SCALE,
  MIN_FONT_WIDTH_SCALE,
} from "../../lib/blockFormatGeometry";
import type { BlockFormatDefaults } from "../../../../shared/settingsTypes";
import {
  BlockFormatControlCaption as DirectControlCaption,
  BlockFormatSectionHeading as DirectSectionHeading,
  FormatSliderControl,
} from "../blockFormat/BlockFormatPrimitives";
import { TextWrappingSelect } from "../TextWrappingSelect";
import {
  PresetGroupControl,
  type PresetGroupAvailability,
} from "./PresetGroupControl";

type DetailSectionProps = {
  presetGroups?: PresetGroupAvailability;
  value: BlockFormatDefaults;
  onChange: (patch: Partial<BlockFormatDefaults>) => void;
};

export function FormatDefaultsColorSection({
  presetGroups,
  value,
  onChange,
}: DetailSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <div className="gather-direct-editor-section-head">
        <strong>{t("settings.format.color.title")}</strong>
        <PresetGroupControl
          availability={presetGroups}
          className="format-preset-outline-toggle-guard"
          groupId="outline"
        >
          <button
            type="button"
            className="format-defaults-outline-toggle"
            aria-pressed={value.outlineEnabled}
            onClick={() => onChange({ outlineEnabled: !value.outlineEnabled })}
          >
            <span aria-hidden="true" />
            {t("settings.format.color.outlineEnabled")}
          </button>
        </PresetGroupControl>
      </div>
      <div className="gather-direct-editor-color-row">
        <PresetGroupControl availability={presetGroups} groupId="color">
          <DefaultColorControl
            label={t("settings.format.color.text")}
            value={value.textColor}
            onChange={(textColor) => onChange({ textColor })}
          />
        </PresetGroupControl>
        <PresetGroupControl availability={presetGroups} groupId="outline">
          <DefaultColorControl
            label={t("settings.format.color.outline")}
            value={value.outlineColor}
            disabled={!value.outlineEnabled}
            onChange={(outlineColor) => onChange({ outlineColor })}
          />
        </PresetGroupControl>
        <PresetGroupControl
          availability={presetGroups}
          className="format-preset-color-slider-guard"
          groupId="outline"
        >
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
        </PresetGroupControl>
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
  presetGroups,
  value,
  onChange,
  rotationDeg,
  onRotationChange,
}: DetailSectionProps & {
  rotationDeg?: number;
  onRotationChange?: (rotationDeg: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-editor-section">
      <DirectSectionHeading title={t("gatherText.detailsSection")} />
      <div className="gather-direct-editor-slider-grid">
        <FineTuningWordBreakControl
          presetGroups={presetGroups}
          value={value}
          onChange={onChange}
        />
        <PresetGroupControl availability={presetGroups} groupId="lineSpacing">
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
        </PresetGroupControl>
        <PresetGroupControl availability={presetGroups} groupId="letterSpacing">
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
        </PresetGroupControl>
        <PresetGroupControl availability={presetGroups} groupId="fontWidth">
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
        </PresetGroupControl>
        <FineTuningTransformControls
          presetGroups={presetGroups}
          rotationDeg={rotationDeg}
          value={value}
          onChange={onChange}
          onRotationChange={onRotationChange}
        />
      </div>
    </section>
  );
}

function FineTuningWordBreakControl({
  presetGroups,
  value,
  onChange,
}: DetailSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <PresetGroupControl availability={presetGroups} groupId="wordBreak">
      <label className="gather-direct-select-control">
        <DirectControlCaption
          label={t("format.wordBreak.label")}
          mixed={false}
          touched={false}
        />
        <TextWrappingSelect
          ariaLabel={t("format.wordBreak.label")}
          value={value.wordBreak}
          onChange={(wordBreak) => onChange({ wordBreak })}
        />
      </label>
    </PresetGroupControl>
  );
}

function FineTuningTransformControls({
  presetGroups,
  rotationDeg,
  value,
  onChange,
  onRotationChange,
}: DetailSectionProps & {
  rotationDeg?: number;
  onRotationChange?: (rotationDeg: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <PresetGroupControl availability={presetGroups} groupId="transform">
        <FormatSliderControl
          label={t("format.textOpacity")}
          valueLabel={formatPercent(value.textOpacity)}
          min={0}
          max={1}
          step={0.01}
          value={value.textOpacity}
          onChange={(textOpacity) => onChange({ textOpacity })}
        />
      </PresetGroupControl>
      {rotationDeg !== undefined && onRotationChange ? (
        <PresetGroupControl availability={presetGroups} groupId="transform">
          <FormatSliderControl
            label={t("format.rotation")}
            valueLabel={`${Math.round(rotationDeg)}°`}
            min={-180}
            max={180}
            step={1}
            value={rotationDeg}
            onChange={onRotationChange}
          />
        </PresetGroupControl>
      ) : null}
    </>
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
