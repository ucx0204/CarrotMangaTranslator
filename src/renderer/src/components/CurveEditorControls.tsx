import React from "react";
import { useTranslation } from "react-i18next";
import type { CurveLayout, TranslationBlock } from "../../../shared/textTypes";
import { createCurvePreset } from "../../../shared/blockTransforms";
import {
  canFitCurveSpacing,
  estimateCurveOverflowPx,
  resolveCurveConstraint,
  resolveTransformBbox,
  type PageSize,
} from "../lib/transformEditorModel";
import { Button } from "./ui/Button";
import { CurveOverflowWarning, CurveRemoveButton } from "./CurveEditorFeedback";
import { CurveEditorOptions } from "./CurveEditorOptions";

type CurveEditorControlsProps = {
  block: TranslationBlock;
  disabled: boolean;
  pageSize: PageSize;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

export function CurveEditorControls({
  block,
  disabled,
  pageSize,
  onUpdate,
}: CurveEditorControlsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const curve = block.curveLayout;
  const constraint = resolveCurveConstraint(block);
  return (
    <div className="transform-mode-panel curve-editor-controls">
      <CurveStatusRow {...{ constraint, curve, disabled, onUpdate }} />
      <CurveConstraintWarning constraint={constraint} />
      <CurveEditorBody
        {...{ block, constraint, curve, disabled, pageSize, onUpdate }}
      />
      <p className="transform-help">{t("transform.hints.curve")}</p>
    </div>
  );
}

type CurveConstraint = ReturnType<typeof resolveCurveConstraint>;

function CurveStatusRow({
  constraint,
  curve,
  disabled,
  onUpdate,
}: Pick<CurveEditorControlsProps, "disabled" | "onUpdate"> & {
  constraint: CurveConstraint;
  curve: CurveLayout | undefined;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const status = curve ? (constraint ? "suspended" : "active") : "inactive";
  return (
    <div className="transform-status-row">
      <span className={`transform-status-chip ${status}`}>
        {t(`transform.${status}`)}
      </span>
      {!curve ? (
        <Button
          size="sm"
          disabled={disabled || Boolean(constraint)}
          onClick={() =>
            onUpdate({ curveLayout: createCurvePreset("straight") })
          }
        >
          {t("transform.curve.convert")}
        </Button>
      ) : null}
    </div>
  );
}

function CurveConstraintWarning({
  constraint,
}: {
  constraint: CurveConstraint;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!constraint) return null;
  return (
    <p className="transform-warning" role="status" aria-live="polite">
      {t(`transform.curve.constraints.${constraint}`)}
    </p>
  );
}

function CurveEditorBody({
  curve,
  constraint,
  ...props
}: CurveEditorControlsProps & {
  curve: CurveLayout | undefined;
  constraint: CurveConstraint;
}): React.JSX.Element | null {
  if (!curve) return null;
  if (constraint) {
    return (
      <CurveRemoveButton disabled={props.disabled} onUpdate={props.onUpdate} />
    );
  }
  return <ActiveCurveControls {...props} curve={curve} />;
}

function ActiveCurveControls({
  block,
  curve,
  disabled,
  pageSize,
  onUpdate,
}: CurveEditorControlsProps & { curve: CurveLayout }): React.JSX.Element {
  const { t } = useTranslation("components");
  const bbox = resolveTransformBbox(block, pageSize);
  const overflowPx = estimateCurveOverflowPx(block, bbox, pageSize);
  const spacingCanFit = canFitCurveSpacing(block, bbox, pageSize);
  const updateCurve = (next: CurveLayout): void =>
    onUpdate({ curveLayout: next });
  return (
    <>
      <CurveEditorOptions
        curve={curve}
        disabled={disabled}
        onUpdate={updateCurve}
      />
      <div className="transform-curve-actions">
        <Button
          size="sm"
          variant={curve.reversed ? "secondary" : "ghost"}
          aria-pressed={Boolean(curve.reversed)}
          disabled={disabled}
          onClick={() => updateCurve({ ...curve, reversed: !curve.reversed })}
        >
          {t("transform.curve.reverse")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => updateCurve(createCurvePreset("straight"))}
        >
          {t("transform.curve.reset")}
        </Button>
      </div>
      {overflowPx > 0 ? (
        <CurveOverflowWarning
          block={block}
          curve={curve}
          disabled={disabled}
          overflowPx={overflowPx}
          spacingCanFit={spacingCanFit}
          onUpdate={onUpdate}
        />
      ) : null}
      <CurveRemoveButton disabled={disabled} onUpdate={onUpdate} />
    </>
  );
}
