import { useTranslation } from "react-i18next";
import {
  IconArrowLeft,
  IconArrowRight,
  IconGripVertical,
  IconTrash,
} from "@tabler/icons-react";

import React from "react";

import {
  createConditionalCaptureId,
  type ConditionalPatternNodeV3,
  type ConditionalPatternRepeatV3,
} from "../../../shared/conditionalTextPattern";

import { CheckboxField } from "./ui/CheckboxField";
import { Select } from "./ui/Select";

import { IconButton } from "./ui/IconButton";

import styles from "./ConditionalBatchEditor.module.css";

import { Button as UiButton } from "./ui/Button";

import { Input } from "./ui/Field";

import {
  isOnce,
  patternNodeLabel,
  repeatFromPreset,
  repeatLabel,
  repeatPreset,
} from "./conditionalPatternEditorModel";

type PatternChipProps = {
  node: ConditionalPatternNodeV3;
  captureLabel?: string;
  active: boolean;
  dragged: boolean;
  reorderable: boolean;
  onActivate: () => void;
  onChange: (node: ConditionalPatternNodeV3) => void;
  onDragEnd: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onMove: (offset: -1 | 1) => void;
};

export function PatternChip({
  node,
  captureLabel,
  active,
  dragged,
  reorderable,
  onActivate,
  onChange,
  onDragEnd,
  onDragStart,
  onDrop,
  onMove,
}: PatternChipProps) {
  useTranslation();
  if (node.kind === "literal") {
    return (
      <>
        <LiteralPatternChip
          node={node}
          captureLabel={captureLabel}
          dragged={dragged}
          reorderable={reorderable}
          onActivate={onActivate}
          onChange={onChange}
          onDragEnd={onDragEnd}
          onDragStart={onDragStart}
          onDrop={onDrop}
          onMove={onMove}
        />
      </>
    );
  }
  return (
    <span
      className={styles.patternChip}
      data-active={active}
      data-dragged={dragged}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      {reorderable ? (
        <PatternDragHandle onDragEnd={onDragEnd} onDragStart={onDragStart} />
      ) : null}
      <UiButton
        type="button"
        className={styles.patternChipMain}
        onClick={onActivate}
        onKeyDown={(event) => handlePatternMoveKeyDown(event, onMove)}
        variant="bare"
      >
        <span>{patternNodeLabel(node)}</span>
        {"repeat" in node && !isOnce(node.repeat) ? (
          <small>{repeatLabel(node.repeat)}</small>
        ) : null}
        {captureLabel ? <em>{captureLabel}</em> : null}
      </UiButton>
    </span>
  );
}

function handlePatternMoveKeyDown(
  event: React.KeyboardEvent,
  onMove: (offset: -1 | 1) => void,
): void {
  if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  onMove(event.key === "ArrowLeft" ? -1 : 1);
}

export function PatternNodeToolbar({
  node,
  captureLabel,
  canMoveLeft,
  canMoveRight,
  onChange,
  onMove,
  onRemove,
}: {
  node: ConditionalPatternNodeV3;
  captureLabel?: string;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onChange: (node: ConditionalPatternNodeV3) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("components");
  const matchable = node.kind !== "boundary" ? node : null;
  return (
    <div className={styles.patternNodeToolbar}>
      {matchable ? (
        <RepeatEditor
          key={matchable.id}
          repeat={matchable.repeat}
          onChange={(repeat) => onChange({ ...matchable, repeat })}
        />
      ) : (
        <span className={styles.patternMeta}>
          {t("patternEditorCopy.positionCondition")}
        </span>
      )}
      {node.kind === "choice" ? (
        <Input
          aria-label={t("patternEditorCopy.optionList")}
          value={node.options.join(" / ")}
          onChange={(event) => {
            const options = event.target.value
              .split("/")
              .map((value) => value.trim());
            onChange({ ...node, options });
          }}
        />
      ) : null}
      {matchable ? (
        <CheckboxField
          checked={Boolean(matchable.captureId)}
          label={captureLabel ?? t("patternEditorCopy.captureForReplacement")}
          onCheckedChange={(checked) =>
            onChange({
              ...matchable,
              captureId: checked
                ? (matchable.captureId ?? createConditionalCaptureId())
                : undefined,
            })
          }
        />
      ) : null}
      <PatternOrderingButtons
        canMoveLeft={canMoveLeft}
        canMoveRight={canMoveRight}
        onMove={onMove}
        onRemove={onRemove}
      />
    </div>
  );
}

function RepeatEditor({
  repeat,
  onChange,
}: {
  repeat: ConditionalPatternRepeatV3;
  onChange: (repeat: ConditionalPatternRepeatV3) => void;
}) {
  const { t } = useTranslation("components");
  const [countMode, setCountMode] = React.useState<"exact" | "range" | null>(
    null,
  );
  const preset = countMode ?? repeatPreset(repeat);
  return (
    <>
      <Select
        ariaLabel={t("patternEditorCopy.repetitions")}
        value={preset}
        options={[
          { value: "once", label: t("patternEditorCopy.once") },
          { value: "optional", label: t("patternEditorCopy.optional") },
          { value: "oneOrMore", label: t("patternEditorCopy.oneOrMore26") },
          { value: "zeroOrMore", label: t("patternEditorCopy.zeroOrMore") },
          { value: "exact", label: t("patternEditorCopy.exactlyN") },
          { value: "range", label: t("patternEditorCopy.nToM") },
        ]}
        onValueChange={(value) => {
          setCountMode(value === "exact" || value === "range" ? value : null);
          onChange(repeatFromPreset(value, repeat));
        }}
      />
      {preset === "exact" || preset === "range" ? (
        <span className={styles.repeatNumbers}>
          <Input
            aria-label={t("patternEditorCopy.minimumRepetitions")}
            type="number"
            min={0}
            max={999}
            value={repeat.min}
            onChange={(event) =>
              onChange({
                ...repeat,
                min: Math.max(0, Number(event.target.value)),
                max:
                  preset === "exact"
                    ? Math.max(0, Number(event.target.value))
                    : repeat.max,
              })
            }
          />
          {preset === "range" ? (
            <>
              <span>~</span>
              <Input
                aria-label={t("patternEditorCopy.maximumRepetitions")}
                type="number"
                min={repeat.min}
                max={999}
                value={repeat.max ?? repeat.min}
                onChange={(event) =>
                  onChange({
                    ...repeat,
                    max: Math.max(repeat.min, Number(event.target.value)),
                  })
                }
              />
            </>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

function PatternOrderingButtons({
  canMoveLeft,
  canMoveRight,
  onMove,
  onRemove,
}: {
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("components");
  return (
    <span className={styles.patternToolbarActions}>
      <IconButton
        size="sm"
        label={t("patternEditorCopy.moveLeft")}
        disabled={!canMoveLeft}
        onClick={() => onMove(-1)}
      >
        <IconArrowLeft size={14} />
      </IconButton>
      <IconButton
        size="sm"
        label={t("patternEditorCopy.moveRight")}
        disabled={!canMoveRight}
        onClick={() => onMove(1)}
      >
        <IconArrowRight size={14} />
      </IconButton>
      <IconButton
        size="sm"
        variant="danger"
        label={t("patternEditorCopy.deletePart")}
        onClick={onRemove}
      >
        <IconTrash size={14} />
      </IconButton>
    </span>
  );
}

function PatternDragHandle({
  onDragEnd,
  onDragStart,
}: {
  onDragEnd: () => void;
  onDragStart: () => void;
}) {
  const { t } = useTranslation("components");
  return (
    <UiButton
      type="button"
      className={styles.patternDragHandle}
      aria-label={t("patternEditorCopy.dragPatternPart")}
      draggable
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      variant="bare"
    >
      <IconGripVertical size={12} />
    </UiButton>
  );
}

function LiteralPatternChip({
  node,
  captureLabel,
  dragged,
  reorderable,
  onActivate,
  onChange,
  onDragEnd,
  onDragStart,
  onDrop,
  onMove,
}: {
  node: Extract<ConditionalPatternNodeV3, { kind: "literal" }>;
  captureLabel: string | undefined;
  dragged: boolean;
  reorderable: boolean;
  onActivate: () => void;
  onChange: (node: ConditionalPatternNodeV3) => void;
  onDragEnd: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onMove: (offset: -1 | 1) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <span
      className={styles.patternLiteralPart}
      data-dragged={dragged}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      {reorderable ? (
        <PatternDragHandle onDragEnd={onDragEnd} onDragStart={onDragStart} />
      ) : null}
      <Input
        className={styles.patternLiteralInput}
        aria-label={t("patternEditorCopy.literalText")}
        placeholder={t("conditionalBatch.then.find")}
        value={node.text}
        onFocus={reorderable ? onActivate : undefined}
        onKeyDown={(event) => handlePatternMoveKeyDown(event, onMove)}
        onChange={(event) => onChange({ ...node, text: event.target.value })}
      />
      {captureLabel ? <em>{captureLabel}</em> : null}
    </span>
  );
}
