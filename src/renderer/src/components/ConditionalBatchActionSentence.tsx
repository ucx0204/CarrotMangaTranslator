import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconGripVertical,
  IconTrash,
} from "@tabler/icons-react";

import type { BlockStylePreset } from "../../../shared/blockStylePresets";

import {
  MAX_CONDITIONAL_BATCH_ACTIONS,
  type ConditionalBatchActionV2,
  type ConditionalBatchPreviewResult,
} from "../../../shared/conditionalBatchRules";

import { actionStage } from "./conditionalBatchDraftDefaults";
import { summarizeAction } from "./conditionalBatchPresentation";

import { CheckboxField } from "./ui/CheckboxField";

import { TextField } from "./ui/Field";

import { IconButton } from "./ui/IconButton";

import { ConditionalBatchSetFieldsEditor } from "./ConditionalBatchSetFieldsEditor";

import styles from "./ConditionalBatchEditor.module.css";

import { Button as UiButton } from "./ui/Button";

import { ReplaceActionEditor } from "./ConditionalBatchReplaceActionEditor";

import { readActionSample } from "./conditionalBatchActionModel";

import { PresetActionEditor } from "./ConditionalBatchPresetActionEditor";

import { StyleTextActionEditor } from "./ConditionalBatchStyleTextEditor";

type ActionSentenceCardProps = {
  action: ConditionalBatchActionV2;
  actions: readonly ConditionalBatchActionV2[];
  blockStylePresets: readonly BlockStylePreset[];
  currentResult: ConditionalBatchPreviewResult | null;
  dragged: boolean;
  expanded: boolean;
  index: number;
  onChange: (action: ConditionalBatchActionV2) => void;
  onDragEnd: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onDuplicate: () => void;
  onExpand: () => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
};

export function ActionSentenceCard({
  action,
  actions,
  blockStylePresets,
  currentResult,
  dragged,
  expanded,
  index,
  onChange,
  onDragEnd,
  onDragStart,
  onDrop,
  onDuplicate,
  onExpand,
  onMove,
  onRemove,
}: ActionSentenceCardProps) {
  const { t } = useTranslation("components");
  const sameStage = actions.filter(
    (entry) => actionStage(entry) === actionStage(action),
  );
  const stageIndex = sameStage.findIndex((entry) => entry.id === action.id);
  return (
    <article
      className={styles.sentenceCard}
      data-dragged={dragged}
      data-enabled={action.enabled}
      data-expanded={expanded}
      draggable={sameStage.length > 1}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <ActionSentenceHeader
        sameStage={sameStage}
        stageIndex={stageIndex}
        action={action}
        actions={actions}
        index={index}
        onMove={onMove}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        expanded={expanded}
        onExpand={onExpand}
        onChange={onChange}
      />
      {expanded ? (
        <div className={styles.inlineEditor}>
          <ActionEditor
            action={action}
            currentResult={currentResult}
            presets={blockStylePresets}
            onChange={onChange}
          />
          <TextField
            label={t("styleGuide.note")}
            placeholder={t("batchEditorCopy.optional")}
            value={action.note ?? ""}
            maxLength={500}
            onChange={(event) =>
              onChange({
                ...action,
                note: event.target.value || undefined,
              })
            }
          />
        </div>
      ) : null}
    </article>
  );
}

function actionEditorTitle(
  action: ConditionalBatchActionV2,
  t: TFunction<"components">,
): string {
  if (action.type === "replaceText") return t("batchEditorCopy.findAndReplace");
  if (action.type === "setFields") {
    const textOnly =
      action.changes.length === 1 &&
      ["sourceText", "translatedText"].includes(action.changes[0]?.field ?? "");
    return textOnly
      ? t("batchEditorCopy.replaceAllText")
      : t("batchEditorCopy.changeProperties");
  }
  if (action.type === "applyStylePreset") return t("manualRedaction.usePreset");
  return t("batchEditorCopy.formatPartOfText");
}

function ActionEditor({
  action,
  currentResult,
  presets,
  onChange,
}: {
  action: ConditionalBatchActionV2;
  currentResult: ConditionalBatchPreviewResult | null;
  presets: readonly BlockStylePreset[];
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  useTranslation();
  if (action.type === "replaceText") {
    return (
      <ReplaceActionEditor
        action={action}
        sampleText={readActionSample(action, currentResult)}
        onChange={onChange}
      />
    );
  }
  if (action.type === "setFields") {
    return (
      <ConditionalBatchSetFieldsEditor action={action} onChange={onChange} />
    );
  }
  if (action.type === "applyStylePreset") {
    return (
      <PresetActionEditor
        action={action}
        presets={presets}
        onChange={onChange}
      />
    );
  }
  return (
    <StyleTextActionEditor
      action={action}
      sampleText={readActionSample(action, currentResult)}
      onChange={onChange}
    />
  );
}

function ActionOrderingButtons({
  sameStage,
  stageIndex,
  actions,
  index,
  onMove,
  onDuplicate,
  onRemove,
}: {
  sameStage: ConditionalBatchActionV2[];
  stageIndex: number;
  actions: readonly ConditionalBatchActionV2[];
  index: number;
  onMove: (offset: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.rowActions}>
      {sameStage.length > 1 ? (
        <>
          <IconButton
            size="sm"
            label={t("batchEditorCopy.moveActionUp")}
            disabled={stageIndex <= 0}
            onClick={() => onMove(-1)}
          >
            <IconArrowUp size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("batchEditorCopy.moveActionDown")}
            disabled={stageIndex < 0 || stageIndex >= sameStage.length - 1}
            onClick={() => onMove(1)}
          >
            <IconArrowDown size={14} />
          </IconButton>
        </>
      ) : null}
      <IconButton
        size="sm"
        label={t("batchEditorMessages.duplicateAction", {
          p0: index + 1,
        })}
        disabled={actions.length >= MAX_CONDITIONAL_BATCH_ACTIONS}
        onClick={onDuplicate}
      >
        <IconCopy size={14} />
      </IconButton>
      <IconButton
        size="sm"
        variant="danger"
        label={t("batchEditorMessages.deleteAction", {
          p0: index + 1,
        })}
        onClick={onRemove}
      >
        <IconTrash size={14} />
      </IconButton>
    </div>
  );
}

function ActionSentenceHeader({
  sameStage,
  stageIndex,
  action,
  actions,
  index,
  onMove,
  onDuplicate,
  onRemove,
  expanded,
  onExpand,
  onChange,
}: {
  sameStage: ConditionalBatchActionV2[];
  stageIndex: number;
  action: ConditionalBatchActionV2;
  actions: readonly ConditionalBatchActionV2[];
  index: number;
  onMove: (offset: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  expanded: boolean;
  onExpand: () => void;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.sentenceHeader}>
      {sameStage.length > 1 ? (
        <span className={styles.dragHandle} aria-hidden="true">
          <IconGripVertical size={16} />
        </span>
      ) : null}
      <CheckboxField
        checked={action.enabled}
        ariaLabel={t("batchEditorMessages.enableAction", {
          p0: index + 1,
        })}
        onCheckedChange={(enabled) => onChange({ ...action, enabled })}
      />
      <UiButton
        type="button"
        className={styles.sentenceSummary}
        aria-expanded={expanded}
        onClick={onExpand}
        variant="bare"
      >
        <span>
          {expanded ? actionEditorTitle(action, t) : summarizeAction(action)}
        </span>
      </UiButton>
      <ActionOrderingButtons
        sameStage={sameStage}
        stageIndex={stageIndex}
        actions={actions}
        index={index}
        onMove={onMove}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
      />
    </div>
  );
}
