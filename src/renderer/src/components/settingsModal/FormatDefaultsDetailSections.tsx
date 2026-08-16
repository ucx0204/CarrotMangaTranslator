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
  MAX_FONT_WIDTH_SCALE,
  MIN_FONT_WIDTH_SCALE,
} from "../../lib/blockFormatGeometry";
import type { BlockFormatDefaults } from "../../../../shared/settingsTypes";
import {
  DEFAULT_MANUAL_TEXT_OUTLINE_WIDTH_PX,
  MAX_TEXT_OUTLINE_WIDTH_PX,
  MIN_TEXT_OUTLINE_WIDTH_PX,
  TEXT_OUTLINE_WIDTH_STEP_PX,
  resolveEffectiveTextOutlineWidthPx,
  snapTextOutlineWidthPx,
} from "../../../../shared/textOutline";
import {
  BlockFormatControlCaption as DirectControlCaption,
  BlockFormatSectionHeading as DirectSectionHeading,
  FormatNumberControl,
  FormatSliderControl,
} from "../blockFormat/BlockFormatPrimitives";
import { TextWrappingSelect } from "../TextWrappingSelect";
import { CheckboxField } from "../ui/CheckboxField";
import {
  PresetGroupControl,
  type PresetGroupAvailability,
} from "./PresetGroupControl";

type DetailSectionProps = {
  presetGroups?: PresetGroupAvailability;
  value: BlockFormatDefaults;
  onChange: (patch: Partial<BlockFormatDefaults>) => void;
};

let lastPositiveDefaultOutlineWidthPx =
  DEFAULT_MANUAL_TEXT_OUTLINE_WIDTH_PX;

export function FormatDefaultsColorSection({
  presetGroups,
  value,
  onChange,
}: DetailSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const outlineWidthPx = resolveEffectiveTextOutlineWidthPx(
    value,
    value.fontSizePx,
  );
  React.useEffect(() => {
    if (outlineWidthPx > 0) {
      lastPositiveDefaultOutlineWidthPx =
        snapTextOutlineWidthPx(outlineWidthPx);
    }
  }, [outlineWidthPx]);
  return (
    <section className="gather-direct-editor-section">
      <div className="gather-direct-editor-section-head">
        <strong>{t("settings.format.color.title")}</strong>
        <PresetGroupControl
          availability={presetGroups}
          className="format-preset-outline-toggle-guard"
          groupId="outline"
        >
          <CheckboxField
            className="inline-toggle format-defaults-outline-checkbox"
            label={t("settings.format.color.outlineEnabled")}
            checked={value.outlineEnabled}
            onCheckedChange={(outlineEnabled) => {
              onChange({
                outlineEnabled,
                ...(outlineEnabled && outlineWidthPx <= 0
                  ? { outlineWidthPx: lastPositiveDefaultOutlineWidthPx }
                  : {}),
              });
            }}
          />
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
          <FormatNumberControl
            label={t("gatherText.outlineWidth")}
            min={MIN_TEXT_OUTLINE_WIDTH_PX}
            max={MAX_TEXT_OUTLINE_WIDTH_PX}
            step={TEXT_OUTLINE_WIDTH_STEP_PX}
            precision={1}
            unit="px"
            value={outlineWidthPx}
            disabled={!value.outlineEnabled}
            onChange={(outlineWidthPx) => onChange({ outlineWidthPx })}
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
          <FormatNumberControl
            label={t("format.lineHeight")}
            min={MIN_LINE_HEIGHT}
            max={MAX_LINE_HEIGHT}
            step={LINE_HEIGHT_STEP}
            precision={2}
            value={value.lineHeight}
            onChange={(lineHeight) =>
              onChange({ lineHeight: round2(lineHeight) })
            }
          />
        </PresetGroupControl>
        <PresetGroupControl availability={presetGroups} groupId="letterSpacing">
          <FormatNumberControl
            label={t("format.letterSpacing")}
            min={MIN_LETTER_SPACING_EM}
            max={MAX_LETTER_SPACING_EM}
            step={LETTER_SPACING_STEP_EM}
            precision={2}
            unit="em"
            value={value.letterSpacing}
            onChange={(letterSpacing) =>
              onChange({ letterSpacing: round2(letterSpacing) })
            }
          />
        </PresetGroupControl>
        <PresetGroupControl availability={presetGroups} groupId="fontWidth">
          <FormatNumberControl
            label={t("format.fontWidth")}
            min={MIN_FONT_WIDTH_SCALE * 100}
            max={MAX_FONT_WIDTH_SCALE * 100}
            step={FONT_WIDTH_SCALE_STEP * 100}
            precision={0}
            unit="%"
            value={value.fontWidthScale * 100}
            onChange={(fontWidthScale) =>
              onChange({ fontWidthScale: round2(fontWidthScale / 100) })
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
