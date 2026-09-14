import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import { DEFAULT_LETTERING_TOOL } from "../../../shared/generatedLetteringMask";
import type { LetteringTool } from "../../../shared/generatedLetteringMaskTypes";
import { Button } from "./ui/Button";
import { NumberField } from "./ui/NumberField";
import { SegmentedControl } from "./ui/SegmentedControl";
import { CheckboxField } from "./ui/CheckboxField";
import { ColorField } from "./ColorField";
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
          <LetteringOutlineSettings
            block={block}
            disabled={disabled}
            onUpdate={onUpdate}
          />
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
                (!artwork.maskStrokes?.some(
                  (stroke) => stroke.space === tool.space,
                ) &&
                  !(tool.space === "asset" && artwork.paintStrokes?.length))
              }
              onClick={() =>
                onUpdate({
                  generatedLettering: {
                    ...artwork,
                    maskStrokes: artwork.maskStrokes?.filter(
                      (stroke) => stroke.space !== tool.space,
                    ),
                    paintStrokes:
                      tool.space === "asset" ? undefined : artwork.paintStrokes,
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
        onChange={(space) =>
          change({
            space,
            ...(space === "page" && tool.mode === "paint"
              ? { mode: "hide" }
              : {}),
          })
        }
        disabled={disabled}
      />
      <div className={styles.row}>
        <SegmentedControl
          singleRow
          ariaLabel={t("letteringBrush.mode")}
          value={tool.mode}
          options={[
            {
              id: "paint",
              label: t("letteringBrush.paint"),
              disabled: tool.space === "page",
            },
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
      {tool.mode === "paint" ? (
        <ColorField
          label={t("letteringBrush.paintColor")}
          value={tool.color ?? "#000000"}
          disabled={disabled}
          onChange={(color) => change({ color })}
        />
      ) : null}
      <LetteringBrushSize tool={tool} change={change} disabled={disabled} />
    </>
  );
}

function LetteringBrushSize({
  tool,
  change,
  disabled,
}: {
  tool: LetteringTool;
  change: (patch: Partial<LetteringTool>) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("components");
  return (
    <div className="editor-format-number-grid">
      <div className="editor-format-number-cell">
        <span>{t("letteringBrush.size")}</span>
        <NumberField
          variant="scrubber"
          ariaLabel={t("letteringBrush.size")}
          decreaseLabel={t("format.decreaseValue", {
            label: t("letteringBrush.size"),
          })}
          increaseLabel={t("format.increaseValue", {
            label: t("letteringBrush.size"),
          })}
          unit="px"
          min={1}
          max={400}
          step={1}
          precision={0}
          value={tool.size}
          commitMode="blur"
          onValueChange={(size) => change({ size })}
          disabled={disabled}
        />
      </div>
      <div className="editor-format-number-cell">
        <span>{t("letteringBrush.softness")}</span>
        <NumberField
          variant="scrubber"
          ariaLabel={t("letteringBrush.softness")}
          decreaseLabel={t("format.decreaseValue", {
            label: t("letteringBrush.softness"),
          })}
          increaseLabel={t("format.increaseValue", {
            label: t("letteringBrush.softness"),
          })}
          unit="%"
          min={0}
          max={100}
          step={1}
          precision={0}
          value={Math.round(tool.softness * 100)}
          commitMode="blur"
          onValueChange={(softness) => change({ softness: softness / 100 })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function LetteringOutlineSettings({
  block,
  disabled,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}) {
  const { t } = useTranslation("components");
  const artwork = block.generatedLettering;
  if (!artwork) return null;
  const outline = artwork.outline ?? { width: 0, color: "#ffffff" };
  const change = (patch: Partial<typeof outline>) =>
    onUpdate({
      generatedLettering: { ...artwork, outline: { ...outline, ...patch } },
    });
  return (
    <div className={`${styles.outline} editor-format-number-grid`}>
      <div className="editor-format-number-cell">
        <span>{t("letteringBrush.outlineWidth")}</span>
        <NumberField
          variant="scrubber"
          ariaLabel={t("letteringBrush.outlineWidth")}
          decreaseLabel={t("format.decreaseValue", {
            label: t("letteringBrush.outlineWidth"),
          })}
          increaseLabel={t("format.increaseValue", {
            label: t("letteringBrush.outlineWidth"),
          })}
          unit="px"
          min={0}
          max={40}
          step={0.5}
          precision={1}
          value={outline.width}
          disabled={disabled}
          commitMode="blur"
          onValueChange={(width) => change({ width })}
        />
      </div>
      <ColorField
        label={t("letteringBrush.outlineColor")}
        value={outline.color}
        disabled={disabled}
        onChange={(color) => change({ color })}
      />
    </div>
  );
}
