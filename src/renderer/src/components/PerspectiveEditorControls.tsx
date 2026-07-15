import React from "react";
import { useTranslation } from "react-i18next";
import type {
  PerspectiveTransform,
  Point,
  TranslationBlock,
} from "../../../shared/textTypes";
import {
  createPerspectivePreset,
  isValidPerspectiveTransform,
  type PerspectivePresetName,
} from "../../../shared/blockTransforms";
import {
  isPerspectiveVisibleOnPage,
  type PageSize,
} from "../lib/transformEditorModel";
import { Button } from "./ui/Button";
import { TransformNumberField } from "./TransformNumberField";

type PerspectiveEditorControlsProps = {
  block: TranslationBlock;
  disabled: boolean;
  pageSize: PageSize;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

const PRESETS: PerspectivePresetName[] = [
  "topNarrow",
  "bottomNarrow",
  "leftNarrow",
  "rightNarrow",
  "skewLeft",
  "skewRight",
];

const CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
type PerspectiveErrorKind = "invalid" | "outside";

export function PerspectiveEditorControls({
  block,
  disabled,
  pageSize,
  onUpdate,
}: PerspectiveEditorControlsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const perspective = block.perspectiveTransform;
  const perspectiveKey = perspective
    ? perspective.corners.flatMap((point) => [point.x, point.y]).join(":")
    : "none";
  const [errorAt, setErrorAt] = React.useState<{
    blockId: string;
    kind: PerspectiveErrorKind;
    perspectiveKey: string;
  } | null>(null);
  const error =
    errorAt?.blockId === block.id && errorAt.perspectiveKey === perspectiveKey;
  const apply = (next: PerspectiveTransform): void => {
    if (!isValidPerspectiveTransform(next)) {
      setErrorAt({ blockId: block.id, kind: "invalid", perspectiveKey });
      return;
    }
    if (!isPerspectiveVisibleOnPage(block, next, pageSize)) {
      setErrorAt({ blockId: block.id, kind: "outside", perspectiveKey });
      return;
    }
    setErrorAt(null);
    onUpdate({ perspectiveTransform: next });
  };
  return (
    <div className="transform-mode-panel perspective-editor-controls">
      <PerspectiveStatusRow
        disabled={disabled}
        perspective={perspective}
        onResetError={() => setErrorAt(null)}
        onUpdate={onUpdate}
      />
      <PerspectivePresetSelect disabled={disabled} onApply={apply} />
      {perspective ? (
        <PerspectiveAdvancedFields
          disabled={disabled}
          error={error}
          perspective={perspective}
          onApply={apply}
        />
      ) : null}
      <PerspectiveErrorMessage
        kind={error ? (errorAt?.kind ?? "invalid") : null}
      />
      <p className="transform-help">{t("transform.hints.perspective")}</p>
    </div>
  );
}

function PerspectiveStatusRow({
  disabled,
  perspective,
  onResetError,
  onUpdate,
}: Pick<PerspectiveEditorControlsProps, "disabled" | "onUpdate"> & {
  perspective: PerspectiveTransform | undefined;
  onResetError: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="transform-status-row">
      <span className={`transform-status-chip ${perspective ? "active" : ""}`}>
        {t(perspective ? "transform.active" : "transform.inactive")}
      </span>
      <Button
        size="sm"
        variant={perspective ? "ghost" : "secondary"}
        disabled={disabled}
        onClick={() => {
          onResetError();
          onUpdate({
            perspectiveTransform: perspective
              ? undefined
              : createPerspectivePreset("identity"),
          });
        }}
      >
        {t(
          perspective
            ? "transform.perspective.reset"
            : "transform.perspective.start",
        )}
      </Button>
    </div>
  );
}

function PerspectivePresetSelect({
  disabled,
  onApply,
}: {
  disabled: boolean;
  onApply: (perspective: PerspectiveTransform) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label className="transform-select-row">
      <span>{t("transform.perspective.quickShape")}</span>
      <select
        value=""
        disabled={disabled}
        onChange={(event) => {
          const preset = event.target.value as PerspectivePresetName;
          if (preset) onApply(createPerspectivePreset(preset));
        }}
      >
        <option value="">{t("transform.perspective.custom")}</option>
        {PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {t(`transform.perspective.presets.${preset}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

function PerspectiveErrorMessage({
  kind,
}: {
  kind: PerspectiveErrorKind | null;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!kind) return null;
  return (
    <p className="transform-warning" role="status" aria-live="polite">
      {t(`transform.perspective.${kind}`)}
    </p>
  );
}

function PerspectiveAdvancedFields({
  disabled,
  error,
  perspective,
  onApply,
}: {
  disabled: boolean;
  error: boolean;
  perspective: PerspectiveTransform;
  onApply: (perspective: PerspectiveTransform) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const updatePoint = (
    index: number,
    axis: keyof Point,
    value: number,
  ): void => {
    const corners = perspective.corners.map((point, pointIndex) =>
      pointIndex === index ? { ...point, [axis]: value / 100 } : { ...point },
    ) as PerspectiveTransform["corners"];
    onApply({ ...perspective, corners });
  };
  return (
    <details className="transform-advanced">
      <summary>{t("transform.perspective.advanced")}</summary>
      <div className="transform-corner-grid">
        {perspective.corners.flatMap((point, index) =>
          (["x", "y"] as const).map((axis) => (
            <TransformNumberField
              key={`${index}-${axis}`}
              label={`${t(`transform.perspective.corners.${CORNERS[index]}`)} ${axis.toUpperCase()}`}
              value={Math.round(point[axis] * 1000) / 10}
              min={-100}
              max={200}
              step={0.1}
              unit="%"
              disabled={disabled}
              invalid={error}
              onCommit={(value) => updatePoint(index, axis, value)}
            />
          )),
        )}
      </div>
    </details>
  );
}
