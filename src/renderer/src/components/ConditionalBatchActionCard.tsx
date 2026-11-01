import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";

import React from "react";

import type { BlockStylePreset } from "../../../shared/blockStylePresets";

import {
  MAX_CONDITIONAL_BATCH_ACTIONS,
  type ConditionalBatchPreviewResult,
  type ConditionalBatchSchemeDraftV2,
} from "../../../shared/conditionalBatchRules";

import { ConditionalBatchCollapsibleCard } from "./ConditionalBatchControls";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";

import styles from "./ConditionalBatchEditor.module.css";

import { createActionActions } from "./conditionalBatchActionModel";

import { ActionSentenceCard } from "./ConditionalBatchActionSentence";

export type ConditionalBatchActionsCardProps = {
  blockStylePresets: readonly BlockStylePreset[];
  currentResult: ConditionalBatchPreviewResult | null;
  draft: ConditionalBatchSchemeDraftV2;
  expanded: boolean;
  onChangeDraft: (draft: ConditionalBatchSchemeDraftV2) => void;
  onToggle: () => void;
};

export function ConditionalBatchActionCard(
  props: ConditionalBatchActionsCardProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const [activeId, setActiveId] = React.useState<string | null>(
    props.draft.actions[0]?.id ?? null,
  );
  const [draggedId, setDraggedId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (
      !activeId ||
      !props.draft.actions.some((action) => action.id === activeId)
    ) {
      setActiveId(props.draft.actions[0]?.id ?? null);
    }
  }, [activeId, props.draft.actions]);
  const actions = createActionActions(props, setActiveId);
  return (
    <ConditionalBatchCollapsibleCard
      expanded={props.expanded}
      onToggle={props.onToggle}
      title={t("batchEditorCopy.action")}
      summary={
        props.draft.actions.length === 0
          ? t("batchEditorCopy.checkOnly")
          : t("batchEditorMessages.actions", {
              p0: props.draft.actions.length,
            })
      }
    >
      {props.draft.actions.length > 0 ? (
        <div className={styles.actionList}>
          {props.draft.actions.map((action, index) => (
            <ActionSentenceCard
              key={action.id}
              action={action}
              blockStylePresets={props.blockStylePresets}
              currentResult={props.currentResult}
              expanded={activeId === action.id}
              index={index}
              actions={props.draft.actions}
              dragged={draggedId === action.id}
              onChange={(next) => actions.updateAction(action.id, next)}
              onDragEnd={() => setDraggedId(null)}
              onDragStart={() => setDraggedId(action.id)}
              onDrop={() => {
                if (draggedId) actions.dropAction(draggedId, action.id);
                setDraggedId(null);
              }}
              onDuplicate={() => actions.duplicateAction(action.id)}
              onExpand={() => setActiveId(action.id)}
              onMove={(offset) => actions.moveAction(action.id, offset)}
              onRemove={() => actions.removeAction(action.id)}
            />
          ))}
        </div>
      ) : null}
      <ActionAddBar
        disabled={props.draft.actions.length >= MAX_CONDITIONAL_BATCH_ACTIONS}
        presets={props.blockStylePresets}
        onAdd={actions.addAction}
        onAddPreset={actions.addPresetAction}
      />
    </ConditionalBatchCollapsibleCard>
  );
}

function ActionAddBar({
  disabled,
  presets,
  onAdd,
  onAddPreset,
}: {
  disabled: boolean;
  presets: readonly BlockStylePreset[];
  onAdd: (type: "replaceText" | "setFields" | "setText" | "styleText") => void;
  onAddPreset: (preset: BlockStylePreset) => void;
}) {
  const { t } = useTranslation("components");
  const [presetId, setPresetId] = React.useState(presets[0]?.id ?? "");
  return (
    <details className={styles.addMenu}>
      <summary>
        <IconPlus size={15} />
        {t("batchEditorCopy.addAction")}
      </summary>
      <div className={styles.actionAdd}>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onAdd("replaceText")}
        >
          {t("batchEditorCopy.findAndReplace")}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => onAdd("setText")}>
          {t("batchEditorCopy.replaceAllText")}
        </Button>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onAdd("setFields")}
        >
          {t("batchEditorCopy.changeProperties")}
        </Button>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onAdd("styleText")}
        >
          {t("batchEditorCopy.formatPartOfText")}
        </Button>
        {presets.length ? (
          <div className={styles.presetAdd}>
            <Select
              ariaLabel={t("batchEditorCopy.stylePresetToApply")}
              value={presetId}
              options={presets.map((preset) => ({
                value: preset.id,
                label: preset.name,
              }))}
              onValueChange={setPresetId}
            />
            <Button
              size="sm"
              disabled={disabled || !presetId}
              onClick={() => {
                const preset = presets.find((entry) => entry.id === presetId);
                if (preset) onAddPreset(preset);
              }}
            >
              {t("manualRedaction.usePreset")}
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
