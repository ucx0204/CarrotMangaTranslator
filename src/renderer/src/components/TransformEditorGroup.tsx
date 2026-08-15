import React from "react";
import { useTranslation } from "react-i18next";
import type { TransformEditorMode } from "../../../shared/panelBridgeTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { normalizeRotationDeg } from "../lib/blockFormatGeometry";
import {
  bboxFieldToPixels,
  bboxFieldMaximumPixels,
  resolveTransformBbox,
  updateBboxFromPixels,
  type BboxField,
  type PageSize,
} from "../lib/transformEditorModel";
import { Button } from "./ui/Button";
import { RangeInput } from "./ui/Field";
import { TransformNumberField } from "./TransformNumberField";
import { PerspectiveEditorControls } from "./PerspectiveEditorControls";
import { CurveEditorControls } from "./CurveEditorControls";
import { WarpEditorControls } from "./WarpEditorControls";

type TransformEditorGroupProps = {
  block: TranslationBlock;
  disabled: boolean;
  mode: TransformEditorMode;
  pageSize: PageSize | null;
  onSelectMode: (mode: TransformEditorMode) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

export function TransformEditorGroup({
  block,
  disabled,
  mode,
  pageSize,
  onSelectMode,
  onUpdate,
}: TransformEditorGroupProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const resolvedPageSize = pageSize ?? { width: 1000, height: 1000 };
  return (
    <div className="editor-group transform-editor-group">
      <div className="editor-group-head">
        <h3>{t("transform.title")}</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onUpdate({
              rotationDeg: 0,
              perspectiveTransform: undefined,
              curveLayout: undefined,
              warpTransform: undefined,
            })
          }
        >
          {t("transform.resetAll")}
        </Button>
      </div>
      <TransformModeTabs
        disabled={disabled}
        mode={mode}
        onSelectMode={onSelectMode}
      />
      {mode === "select" ? (
        <GeneralTransformControls
          block={block}
          disabled={disabled}
          pageSize={resolvedPageSize}
          onUpdate={onUpdate}
        />
      ) : null}
      {mode === "perspective" ? (
        <PerspectiveEditorControls
          block={block}
          disabled={disabled}
          pageSize={resolvedPageSize}
          onUpdate={onUpdate}
        />
      ) : null}
      {mode === "curve" ? (
        <CurveEditorControls
          block={block}
          disabled={disabled}
          pageSize={resolvedPageSize}
          onUpdate={onUpdate}
        />
      ) : null}
      {mode === "warp" ? (
        <WarpEditorControls
          block={block}
          disabled={disabled}
          pageSize={resolvedPageSize}
          onUpdate={onUpdate}
        />
      ) : null}
    </div>
  );
}

function TransformModeTabs({
  disabled,
  mode,
  onSelectMode,
}: {
  disabled: boolean;
  mode: TransformEditorMode;
  onSelectMode: (mode: TransformEditorMode) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const modes: TransformEditorMode[] = [
    "select",
    "perspective",
    "curve",
    "warp",
  ];
  return (
    <div
      className="transform-mode-tabs"
      role="toolbar"
      aria-label={t("transform.modeLabel")}
    >
      {modes.map((entry) => (
        <button
          key={entry}
          type="button"
          aria-pressed={mode === entry}
          disabled={disabled}
          onClick={() => onSelectMode(entry)}
        >
          {t(`transform.modes.${entry}`)}
        </button>
      ))}
    </div>
  );
}

function GeneralTransformControls({
  block,
  disabled,
  pageSize,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  pageSize: PageSize;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [lockRatio, setLockRatio] = React.useState(true);
  const bbox = resolveTransformBbox(block, pageSize);
  const updateField = (field: BboxField, value: number): void => {
    const next = updateBboxFromPixels({
      bbox,
      field,
      lockRatio,
      pageSize,
      value,
    });
    onUpdate({ renderBbox: next, renderBboxSpace: "normalized_1000" });
  };
  return (
    <div className="transform-mode-panel">
      <div className="transform-box-grid">
        <BboxNumberField
          field="x"
          blockBbox={bbox}
          disabled={disabled}
          lockRatio={lockRatio}
          pageSize={pageSize}
          onCommit={updateField}
        />
        <BboxNumberField
          field="y"
          blockBbox={bbox}
          disabled={disabled}
          lockRatio={lockRatio}
          pageSize={pageSize}
          onCommit={updateField}
        />
        <BboxNumberField
          field="w"
          blockBbox={bbox}
          disabled={disabled}
          lockRatio={lockRatio}
          pageSize={pageSize}
          onCommit={updateField}
        />
        <BboxNumberField
          field="h"
          blockBbox={bbox}
          disabled={disabled}
          lockRatio={lockRatio}
          pageSize={pageSize}
          onCommit={updateField}
        />
      </div>
      <label className="transform-lock-ratio">
        <input
          type="checkbox"
          checked={lockRatio}
          disabled={disabled}
          onChange={(event) => setLockRatio(event.target.checked)}
        />
        {t("transform.lockRatio")}
      </label>
      <RotationControl block={block} disabled={disabled} onUpdate={onUpdate} />
      <p className="transform-help">{t("transform.hints.select")}</p>
    </div>
  );
}

function BboxNumberField({
  field,
  blockBbox,
  disabled,
  lockRatio,
  pageSize,
  onCommit,
}: {
  field: BboxField;
  blockBbox: TranslationBlock["bbox"];
  disabled: boolean;
  lockRatio: boolean;
  pageSize: PageSize;
  onCommit: (field: BboxField, value: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <TransformNumberField
      label={t(`transform.fields.${field}`)}
      value={bboxFieldToPixels(blockBbox, field, pageSize)}
      min={field === "w" || field === "h" ? 1 : 0}
      max={bboxFieldMaximumPixels(blockBbox, field, pageSize, lockRatio)}
      unit="px"
      disabled={disabled}
      onCommit={(value) => onCommit(field, value)}
    />
  );
}

function RotationControl({
  block,
  disabled,
  onUpdate,
}: Pick<
  TransformEditorGroupProps,
  "block" | "disabled" | "onUpdate"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const angle = normalizeRotationDeg(block.rotationDeg ?? 0);
  return (
    <div
      className="transform-rotation-row"
      role="group"
      aria-label={t("transform.rotation")}
    >
      <span>{t("transform.rotation")}</span>
      <RangeInput
        aria-label={`${t("transform.rotation")} ${t("transform.controlKinds.slider")}`}
        min={-180}
        max={180}
        step={0.1}
        value={angle}
        disabled={disabled}
        onChange={(event) =>
          onUpdate({ rotationDeg: Number(event.target.value) })
        }
      />
      <TransformNumberField
        label=""
        ariaLabel={`${t("transform.rotation")} ${t("transform.controlKinds.value")} (°)`}
        value={angle}
        min={-360}
        max={360}
        step={0.1}
        unit="°"
        disabled={disabled}
        onCommit={(rotationDeg) =>
          onUpdate({ rotationDeg: normalizeRotationDeg(rotationDeg) })
        }
      />
      <button
        type="button"
        className="transform-inline-reset"
        disabled={disabled || angle === 0}
        onClick={() => onUpdate({ rotationDeg: 0 })}
      >
        {t("transform.resetRotation")}
      </button>
    </div>
  );
}
