import React from "react";
import { useTranslation } from "react-i18next";
import {
  createIdentityWarpTransform,
  createWarpPreset,
  isValidWarpTransform,
  resetWarpPointIndexes,
  resampleWarpTransform,
  WARP_PRESET_NAMES,
  type WarpPresetName,
} from "../../../shared/blockTransforms";
import type {
  TranslationBlock,
  WarpGridSize,
  WarpTransform,
} from "../../../shared/textTypes";
import { useWarpPointSelection } from "../lib/warpPointSelection";
import {
  isWarpVisibleOnPage,
  type PageSize,
} from "../lib/transformEditorModel";
import { TransformNumberField } from "./TransformNumberField";
import { Select } from "./ui/Select";
import "./warpEditorControls.css";

type WarpEditorProps = {
  block: TranslationBlock;
  disabled: boolean;
  pageSize: PageSize;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

type SelectionSetter = (indexes: readonly number[]) => void;

export function WarpEditorControls({
  block,
  disabled,
  onUpdate,
  pageSize,
}: WarpEditorProps): React.JSX.Element {
  return block.warpTransform ? (
    <ActiveWarpEditor
      block={block}
      disabled={disabled}
      onUpdate={onUpdate}
      pageSize={pageSize}
      warp={block.warpTransform}
    />
  ) : (
    <InactiveWarpEditor disabled={disabled} onUpdate={onUpdate} />
  );
}

function InactiveWarpEditor({
  disabled,
  onUpdate,
}: Pick<WarpEditorProps, "disabled" | "onUpdate">): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="transform-mode-panel warp-editor-panel warp-editor-empty">
      <p>{t("transform.warp.disabledDescription")}</p>
      <button
        className="warp-action-button primary"
        disabled={disabled}
        onClick={() =>
          onUpdate({ warpTransform: createIdentityWarpTransform(3) })
        }
        type="button"
      >
        {t("transform.warp.start")}
      </button>
      <p className="transform-help">{t("transform.hints.warp")}</p>
    </div>
  );
}

function ActiveWarpEditor({
  block,
  disabled,
  onUpdate,
  pageSize,
  warp,
}: WarpEditorProps & {
  warp: WarpTransform;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [selected, setSelected] = useWarpPointSelection(
    block.id,
    warp.points.length,
  );
  React.useEffect(() => {
    if (selected.length === 0) setSelected([0]);
  }, [selected.length, setSelected]);
  const primaryIndex = selected[0] ?? 0;
  return (
    <div className="transform-mode-panel warp-editor-panel">
      <WarpGridPresetFields
        disabled={disabled}
        onUpdate={onUpdate}
        setSelected={setSelected}
        warp={warp}
      />
      <WarpPointFields
        block={block}
        disabled={disabled}
        onUpdate={onUpdate}
        pageSize={pageSize}
        primaryIndex={primaryIndex}
        selected={selected}
        setSelected={setSelected}
        warp={warp}
      />
      <WarpEditorActions
        disabled={disabled}
        onUpdate={onUpdate}
        selected={selected}
        warp={warp}
      />
      <p className="transform-help">{t("transform.hints.warp")}</p>
    </div>
  );
}

function WarpGridPresetFields({
  disabled,
  onUpdate,
  setSelected,
  warp,
}: {
  disabled: boolean;
  onUpdate: WarpEditorProps["onUpdate"];
  setSelected: SelectionSetter;
  warp: WarpTransform;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div
        className="warp-grid-size-row"
        role="group"
        aria-label={t("transform.warp.gridSize")}
      >
        <span>{t("transform.warp.gridSize")}</span>
        {[3, 5].map((gridSize) => (
          <button
            aria-pressed={warp.gridSize === gridSize}
            disabled={disabled}
            key={gridSize}
            onClick={() =>
              switchGrid(warp, gridSize as WarpGridSize, onUpdate, setSelected)
            }
            type="button"
          >
            {gridSize}×{gridSize}
          </button>
        ))}
      </div>
      <label className="warp-preset-field">
        <span>{t("transform.warp.preset")}</span>
        <Select
          ariaLabel={t("transform.warp.preset")}
          value=""
          disabled={disabled}
          options={[
            { value: "", label: t("transform.warp.choosePreset") },
            ...WARP_PRESET_NAMES.map((preset) => ({
              value: preset,
              label: t(`transform.warp.presets.${preset}`),
            })),
          ]}
          onValueChange={(nextValue) => {
            const preset = nextValue as WarpPresetName;
            if (!WARP_PRESET_NAMES.includes(preset)) return;
            onUpdate({
              warpTransform: createWarpPreset(preset, warp.gridSize),
            });
          }}
        />
      </label>
    </>
  );
}

function WarpPointFields({
  block,
  disabled,
  onUpdate,
  pageSize,
  primaryIndex,
  selected,
  setSelected,
  warp,
}: {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: WarpEditorProps["onUpdate"];
  pageSize: PageSize;
  primaryIndex: number;
  selected: readonly number[];
  setSelected: SelectionSetter;
  warp: WarpTransform;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const primaryPoint = warp.points[primaryIndex] ?? warp.points[0];
  const side = warp.gridSize + 1;
  return (
    <>
      <label className="warp-point-field">
        <span>{t("transform.warp.selectedPoint")}</span>
        <Select
          ariaLabel={t("transform.warp.selectedPoint")}
          disabled={disabled}
          value={String(primaryIndex)}
          options={warp.points.map((_point, index) => ({
            value: String(index),
            label: t("transform.warp.pointLabel", {
              column: (index % side) + 1,
              row: Math.floor(index / side) + 1,
            }),
          }))}
          onValueChange={(nextValue) => setSelected([Number(nextValue)])}
        />
      </label>
      <div className="warp-coordinate-grid">
        {(["x", "y"] as const).map((axis) => (
          <TransformNumberField
            disabled={disabled}
            key={axis}
            label={axis.toUpperCase()}
            max={500}
            min={-400}
            step={0.1}
            unit="%"
            value={primaryPoint[axis] * 100}
            onCommit={(value) =>
              updateSelectedAxis({
                axis,
                block,
                onUpdate,
                pageSize,
                selected,
                value: value / 100,
                warp,
              })
            }
          />
        ))}
      </div>
    </>
  );
}

function WarpEditorActions({
  disabled,
  onUpdate,
  selected,
  warp,
}: {
  disabled: boolean;
  onUpdate: WarpEditorProps["onUpdate"];
  selected: readonly number[];
  warp: WarpTransform;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="warp-editor-actions">
      <button
        className="warp-action-button"
        disabled={disabled || selected.length === 0}
        onClick={() => {
          const next = resetWarpPointIndexes(warp, selected);
          if (isValidWarpTransform(next)) onUpdate({ warpTransform: next });
        }}
        type="button"
      >
        {t("transform.warp.resetSelected")}
      </button>
      <button
        className="warp-action-button ghost"
        disabled={disabled}
        onClick={() =>
          onUpdate({
            warpTransform: createIdentityWarpTransform(warp.gridSize),
          })
        }
        type="button"
      >
        {t("transform.warp.resetMesh")}
      </button>
      <button
        className="warp-action-button ghost"
        disabled={disabled}
        onClick={() => onUpdate({ warpTransform: undefined })}
        type="button"
      >
        {t("transform.warp.remove")}
      </button>
    </div>
  );
}

function switchGrid(
  warp: WarpTransform,
  gridSize: WarpGridSize,
  onUpdate: (patch: Partial<TranslationBlock>) => void,
  setSelected: (indexes: readonly number[]) => void,
): void {
  if (warp.gridSize === gridSize) return;
  onUpdate({ warpTransform: resampleWarpTransform(warp, gridSize) });
  setSelected([0]);
}

function updateSelectedAxis({
  axis,
  block,
  onUpdate,
  pageSize,
  selected,
  value,
  warp,
}: {
  axis: "x" | "y";
  block: TranslationBlock;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  pageSize: PageSize;
  selected: readonly number[];
  value: number;
  warp: WarpTransform;
}): void {
  const indexes = selected.length > 0 ? selected : [0];
  const primary = warp.points[indexes[0]];
  const delta = value - primary[axis];
  const selectedSet = new Set(indexes);
  const next: WarpTransform = {
    ...warp,
    points: warp.points.map((point, index) =>
      selectedSet.has(index)
        ? { ...point, [axis]: point[axis] + delta }
        : { ...point },
    ),
  };
  if (
    isValidWarpTransform(next) &&
    isWarpVisibleOnPage(block, next, pageSize)
  ) {
    onUpdate({ warpTransform: next });
  }
}
