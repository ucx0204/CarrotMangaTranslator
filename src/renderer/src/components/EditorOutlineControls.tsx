import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { PanelFormatFieldKey } from "../../../shared/panelBridgeTypes";
import {
  DEFAULT_MANUAL_TEXT_OUTLINE_WIDTH_PX,
  MAX_TEXT_OUTLINE_WIDTH_PX,
  MIN_TEXT_OUTLINE_WIDTH_PX,
  TEXT_OUTLINE_WIDTH_STEP_PX,
  resolveEffectiveTextOutlineWidthPx,
  snapTextOutlineWidthPx,
} from "../../../shared/textOutline";
import { ColorField } from "./ColorField";
import { CheckboxField } from "./ui/CheckboxField";
import { NumberField } from "./ui/NumberField";

let lastPositiveOutlineWidthPx = DEFAULT_MANUAL_TEXT_OUTLINE_WIDTH_PX;
let lastPositiveOuterOutlineWidthPx = DEFAULT_MANUAL_TEXT_OUTLINE_WIDTH_PX;

type OutlineControlModel = {
  enabled: boolean;
  toggle: (checked: boolean) => void;
  updateWidth: (value: number) => void;
  widthPx: number;
};

export function EditorOutlineControls({
  block,
  disabled,
  mixedFields = EMPTY_MIXED_FIELDS,
  outlineColor,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  mixedFields?: ReadonlySet<PanelFormatFieldKey>;
  outlineColor: string;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const outline = useEditorOutlineControls(block, onUpdate);
  const outerOutline = useEditorOuterOutlineControls(block, onUpdate);
  return (
    <>
      <OutlineControl
        color={outlineColor}
        colorLabel={t("format.outline")}
        control={outline}
        disabled={disabled}
        colorMixed={mixedFields.has("outlineColor")}
        enabledLabel={t("settings.format.color.outlineEnabled")}
        widthLabel={t("gatherText.outlineWidth")}
        widthMixed={
          mixedFields.has("outlineWidthPx") ||
          mixedFields.has("outlineWidthScale")
        }
        onColorChange={(value) => onUpdate({ outlineColor: value })}
      />
      <OutlineControl
        color={block.outerOutlineColor ?? "#111111"}
        colorLabel={t("format.outerOutline.color", {
          defaultValue: "바깥 외곽선색",
        })}
        control={outerOutline}
        disabled={disabled}
        colorMixed={mixedFields.has("outerOutlineColor")}
        enabledLabel={t("format.outerOutline.enabled", {
          defaultValue: "바깥 외곽선",
        })}
        widthLabel={t("format.outerOutline.width", {
          defaultValue: "바깥 외곽선 두께",
        })}
        widthMixed={mixedFields.has("outerOutlineWidthPx")}
        onColorChange={(value) => onUpdate({ outerOutlineColor: value })}
      />
    </>
  );
}

function OutlineControl({
  color,
  colorMixed,
  colorLabel,
  control,
  disabled,
  enabledLabel,
  onColorChange,
  widthLabel,
  widthMixed,
}: {
  color: string;
  colorMixed: boolean;
  colorLabel: string;
  control: OutlineControlModel;
  disabled: boolean;
  enabledLabel: string;
  onColorChange: (value: string) => void;
  widthLabel: string;
  widthMixed: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-appearance-row editor-outline-property-row">
      <CheckboxField
        className="editor-appearance-toggle"
        label={enabledLabel}
        checked={control.enabled}
        indeterminate={widthMixed}
        disabled={disabled}
        onCheckedChange={(checked) =>
          control.toggle(widthMixed ? true : checked)
        }
      />
      {control.enabled ? (
        <>
          <ColorField
            className="editor-appearance-color"
            label={colorLabel}
            labelHidden
            value={color}
            disabled={disabled}
            mixed={colorMixed}
            onChange={onColorChange}
          />
          <div className="editor-format-number-cell editor-appearance-number">
            <span className="visually-hidden">{widthLabel}</span>
            <NumberField
              variant="scrubber"
              ariaLabel={widthLabel}
              decreaseLabel={t("format.decreaseValue", { label: widthLabel })}
              increaseLabel={t("format.increaseValue", { label: widthLabel })}
              max={MAX_TEXT_OUTLINE_WIDTH_PX}
              min={MIN_TEXT_OUTLINE_WIDTH_PX}
              precision={1}
              step={TEXT_OUTLINE_WIDTH_STEP_PX}
              unit="px"
              value={control.widthPx}
              disabled={disabled}
              mixed={widthMixed}
              onValueChange={control.updateWidth}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

const EMPTY_MIXED_FIELDS: ReadonlySet<PanelFormatFieldKey> = new Set();

function useEditorOutlineControls(
  block: TranslationBlock,
  onUpdate: (patch: Partial<TranslationBlock>) => void,
): OutlineControlModel {
  const widthPx = resolveEffectiveTextOutlineWidthPx(block, block.fontSizePx);
  React.useEffect(() => {
    if (widthPx > 0) {
      lastPositiveOutlineWidthPx = snapTextOutlineWidthPx(widthPx);
    }
  }, [widthPx]);
  return {
    enabled: widthPx > 0,
    widthPx,
    toggle: (checked) => {
      if (!checked) {
        if (widthPx > 0) {
          lastPositiveOutlineWidthPx = snapTextOutlineWidthPx(widthPx);
        }
        onUpdate({ outlineWidthPx: 0 });
        return;
      }
      onUpdate({ outlineWidthPx: lastPositiveOutlineWidthPx });
    },
    updateWidth: (value) => {
      const normalized = snapTextOutlineWidthPx(value);
      if (normalized > 0) lastPositiveOutlineWidthPx = normalized;
      onUpdate({ outlineWidthPx: normalized });
    },
  };
}

function useEditorOuterOutlineControls(
  block: TranslationBlock,
  onUpdate: (patch: Partial<TranslationBlock>) => void,
): OutlineControlModel {
  const widthPx = Math.max(0, block.outerOutlineWidthPx ?? 0);
  React.useEffect(() => {
    if (widthPx > 0) {
      lastPositiveOuterOutlineWidthPx = snapTextOutlineWidthPx(widthPx);
    }
  }, [widthPx]);
  return {
    enabled: widthPx > 0,
    widthPx,
    toggle: (checked) => {
      if (!checked) {
        if (widthPx > 0) {
          lastPositiveOuterOutlineWidthPx = snapTextOutlineWidthPx(widthPx);
        }
        onUpdate({ outerOutlineWidthPx: 0 });
        return;
      }
      onUpdate({
        outerOutlineColor: block.outerOutlineColor ?? "#111111",
        outerOutlineWidthPx: lastPositiveOuterOutlineWidthPx,
      });
    },
    updateWidth: (value) => {
      const normalized = snapTextOutlineWidthPx(value);
      if (normalized > 0) lastPositiveOuterOutlineWidthPx = normalized;
      onUpdate({ outerOutlineWidthPx: normalized });
    },
  };
}
