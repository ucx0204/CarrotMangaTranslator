import React from "react";
import { useTranslation } from "react-i18next";
import type { CurveLayout } from "../../../shared/textTypes";
import {
  MAX_CURVE_OFFSET_EM,
  MIN_CURVE_OFFSET_EM,
  createCurvePreset,
  type CurvePresetName,
} from "../../../shared/blockTransforms";
import { resolveCurveBend, updateCurveBend } from "../lib/transformEditorModel";
import { RangeInput } from "./ui/Field";
import { TransformNumberField } from "./TransformNumberField";

const CURVE_PRESET_NAMES: CurvePresetName[] = [
  "straight",
  "archUp",
  "archDown",
];

type CurveOptionProps = {
  curve: CurveLayout;
  disabled: boolean;
  onUpdate: (curve: CurveLayout) => void;
};

export function CurveEditorOptions({
  curve,
  disabled,
  onUpdate,
}: CurveOptionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <CurvePresetButtons {...{ curve, disabled, onUpdate }} />
      <CurveSliderRow
        label={t("transform.curve.bend")}
        value={resolveCurveBend(curve)}
        min={-100}
        max={100}
        inputMin={-500}
        inputMax={500}
        step={1}
        unit=""
        disabled={disabled}
        onChange={(value) => onUpdate(updateCurveBend(curve, value))}
      />
      <CurveAlignmentButtons {...{ curve, disabled, onUpdate }} />
      <CurveSliderRow
        label={t("transform.curve.offset")}
        value={curve.offsetEm}
        min={-3}
        max={3}
        inputMin={MIN_CURVE_OFFSET_EM}
        inputMax={MAX_CURVE_OFFSET_EM}
        step={0.1}
        unit="em"
        disabled={disabled}
        onChange={(offsetEm) => onUpdate({ ...curve, offsetEm })}
      />
      <CurveOrientationButtons {...{ curve, disabled, onUpdate }} />
      <label className="transform-compact-toggle">
        <input
          type="checkbox"
          checked={Boolean(curve.fitSpacing)}
          disabled={disabled}
          onChange={(event) =>
            onUpdate({ ...curve, fitSpacing: event.target.checked })
          }
        />
        {t("transform.curve.fitSpacing")}
      </label>
    </>
  );
}

function CurvePresetButtons({
  curve,
  disabled,
  onUpdate,
}: CurveOptionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="transform-control-row">
      <span>{t("transform.curve.quickShape")}</span>
      <div className="transform-mini-segments">
        {CURVE_PRESET_NAMES.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={disabled}
            onClick={() =>
              onUpdate({ ...curve, path: createCurvePreset(preset).path })
            }
          >
            {t(`transform.curve.presets.${preset}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function CurveAlignmentButtons(props: CurveOptionProps): React.JSX.Element {
  const { curve, disabled, onUpdate } = props;
  const { t } = useTranslation("components");
  return (
    <CurveSegmentedRow
      label={t("transform.curve.alignment")}
      entries={["start", "center", "end"]}
      active={curve.alignment}
      disabled={disabled}
      labelPrefix="transform.curve.align"
      onSelect={(alignment) =>
        onUpdate({ ...curve, alignment: alignment as CurveLayout["alignment"] })
      }
    />
  );
}

function CurveOrientationButtons(props: CurveOptionProps): React.JSX.Element {
  const { curve, disabled, onUpdate } = props;
  const { t } = useTranslation("components");
  return (
    <CurveSegmentedRow
      label={t("transform.curve.orientation")}
      entries={["tangent", "upright"]}
      active={curve.orientation}
      disabled={disabled}
      labelPrefix="transform.curve.orientations"
      onSelect={(orientation) =>
        onUpdate({
          ...curve,
          orientation: orientation as CurveLayout["orientation"],
        })
      }
    />
  );
}

function CurveSegmentedRow({
  active,
  disabled,
  entries,
  label,
  labelPrefix,
  onSelect,
}: {
  active: string;
  disabled: boolean;
  entries: string[];
  label: string;
  labelPrefix: string;
  onSelect: (entry: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="transform-control-row">
      <span>{label}</span>
      <div className="transform-mini-segments">
        {entries.map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={active === entry}
            disabled={disabled}
            onClick={() => onSelect(entry)}
          >
            {t(`${labelPrefix}.${entry}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function CurveSliderRow({
  label,
  value,
  min,
  max,
  inputMin = min,
  inputMax = max,
  step,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  inputMin?: number;
  inputMax?: number;
  step: number;
  unit: string;
  disabled: boolean;
  onChange: (value: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="transform-slider-row" role="group" aria-label={label}>
      <span>{label}</span>
      <RangeInput
        aria-label={`${label} ${t("transform.controlKinds.slider")}`}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <TransformNumberField
        label=""
        ariaLabel={`${label} ${t("transform.controlKinds.value")}${unit ? ` (${unit})` : ""}`}
        value={value}
        min={inputMin}
        max={inputMax}
        step={step}
        unit={unit}
        disabled={disabled}
        onCommit={onChange}
      />
    </div>
  );
}
