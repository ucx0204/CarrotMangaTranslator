import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { DEFAULT_LETTERING_TOOL } from "../../../shared/generatedLetteringMask";
import type { LetteringTool } from "../../../shared/generatedLetteringMaskTypes";
import { Button } from "./ui/Button";
import { FieldSlider } from "./ui/FieldSlider";
import { SegmentedControl } from "./ui/SegmentedControl";
import { CheckboxField } from "./ui/CheckboxField";
import styles from "./GeneratedLetteringControls.module.css";

export function GeneratedLetteringControls({
  block,
  disabled,
  tool = DEFAULT_LETTERING_TOOL,
  onChange,
  onUpdate,
}: {
  block: TranslationBlock | null;
  disabled: boolean;
  tool?: LetteringTool;
  onChange?: (tool: LetteringTool) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!block?.generatedLettering || !onChange) return null;
  const artwork = block.generatedLettering;
  const active = tool.blockId === block.id;
  const change = (patch: Partial<LetteringTool>) =>
    onChange({ ...tool, ...patch });
  return (
    <div className={styles.controls}>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        aria-pressed={active}
        onClick={() => change({ blockId: active ? null : block.id })}
      >
        {t(active ? "letteringBrush.done" : "letteringBrush.title")}
      </Button>
      {active ? (
        <>
          <LetteringBrushSettings
            tool={tool}
            disabled={disabled}
            change={change}
          />
          <div className={styles.row}>
            <CheckboxField
              label={t("letteringBrush.showMask")}
              checked={tool.showMask}
              onCheckedChange={(showMask) => change({ showMask })}
              disabled={disabled}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={
                disabled ||
                !block.generatedLettering.maskStrokes?.some(
                  (stroke) => stroke.space === tool.space,
                )
              }
              onClick={() =>
                onUpdate({
                  generatedLettering: {
                    ...artwork,
                    maskStrokes: artwork.maskStrokes?.filter(
                      (stroke) => stroke.space !== tool.space,
                    ),
                  },
                })
              }
            >
              {t("letteringBrush.reset")}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function LetteringBrushSettings({
  tool,
  disabled,
  change,
}: {
  tool: LetteringTool;
  disabled: boolean;
  change: (patch: Partial<LetteringTool>) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <>
      <SegmentedControl
        singleRow
        ariaLabel={t("letteringBrush.target")}
        value={tool.space}
        options={[
          { id: "asset", label: t("letteringBrush.asset") },
          { id: "page", label: t("letteringBrush.page") },
        ]}
        onChange={(space) => change({ space })}
        disabled={disabled}
      />
      <div className={styles.row}>
        <SegmentedControl
          singleRow
          ariaLabel={t("letteringBrush.mode")}
          value={tool.mode}
          options={[
            { id: "hide", label: t("letteringBrush.hide") },
            { id: "restore", label: t("letteringBrush.restore") },
          ]}
          onChange={(mode) => change({ mode })}
          disabled={disabled}
        />
        <SegmentedControl
          singleRow
          ariaLabel={t("letteringBrush.shape")}
          value={tool.shape}
          options={[
            { id: "circle", label: t("letteringBrush.circle") },
            { id: "square", label: t("letteringBrush.square") },
          ]}
          onChange={(shape) => change({ shape })}
          disabled={disabled}
        />
      </div>
      <FieldSlider
        label={t("letteringBrush.size")}
        valueLabel={`${tool.size} px`}
        min={1}
        max={400}
        value={tool.size}
        onChange={(event) => change({ size: Number(event.target.value) })}
        disabled={disabled}
      />
      <FieldSlider
        label={t("letteringBrush.softness")}
        valueLabel={`${Math.round(tool.softness * 100)}%`}
        min={0}
        max={100}
        value={tool.softness * 100}
        onChange={(event) =>
          change({ softness: Number(event.target.value) / 100 })
        }
        disabled={disabled}
      />
    </>
  );
}
