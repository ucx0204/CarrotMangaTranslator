import { useTranslation } from "react-i18next";
import { IconCopy, IconEdit, IconTrash } from "@tabler/icons-react";
import React from "react";
import type { ConditionalBatchSequenceV2 } from "../../../shared/conditionalBatchRules";
import { ConditionalBatchCollapsibleTrigger } from "./ConditionalBatchControls";
import styles from "./ConditionalBatchEditor.module.css";
import type { ConditionalBatchRulePanelProps } from "./conditionalBatchRulePanelTypes";
import { ConditionalBatchSequenceForm } from "./ConditionalBatchSequenceForm";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { useConditionalBatchSequenceEditor } from "./useConditionalBatchSequenceEditor";

type ConditionalBatchSequenceManagerProps = Pick<
  ConditionalBatchRulePanelProps,
  | "onDeleteSequence"
  | "onPreviewSequence"
  | "onSaveSequence"
  | "savedSchemes"
  | "sequences"
> & {
  expanded: boolean;
  onToggle: () => void;
};

type ConditionalBatchSequenceRunCardProps = Pick<
  ConditionalBatchRulePanelProps,
  "activeSequence" | "onExitSequence" | "savedSchemes" | "sequencePreview"
>;

export function ConditionalBatchSequenceManager(
  props: ConditionalBatchSequenceManagerProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const bodyId = React.useId();
  const editor = useConditionalBatchSequenceEditor(
    props.savedSchemes,
    props.onSaveSequence,
  );
  return (
    <section
      className={styles.sequenceManager}
      data-expanded={props.expanded}
      inert={editor.saving}
      aria-busy={editor.saving}
    >
      <header className={styles.sequenceHeader}>
        <ConditionalBatchCollapsibleTrigger
          bodyId={bodyId}
          expanded={props.expanded}
          title={t("batchEditorCopy.sequence")}
          onToggle={props.onToggle}
        />
        {props.expanded ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.savedSchemes.length === 0}
            onClick={editor.startNew}
          >
            {t("batchEditorCopy.newSequence")}
          </Button>
        ) : null}
      </header>
      {props.expanded ? (
        <div className={styles.sequenceBody} id={bodyId}>
          <SequenceList
            sequences={props.sequences}
            onDelete={props.onDeleteSequence}
            onEdit={editor.edit}
            onPreview={props.onPreviewSequence}
          />
          {editor.formOpen ? (
            <ConditionalBatchSequenceForm
              {...editor}
              savedSchemes={props.savedSchemes}
              onCancel={editor.reset}
              onSave={() => void editor.save()}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SequenceList({
  sequences,
  onDelete,
  onEdit,
  onPreview,
}: {
  sequences: readonly ConditionalBatchSequenceV2[];
  onDelete: (id: string) => void;
  onEdit: (sequence: ConditionalBatchSequenceV2, duplicate?: boolean) => void;
  onPreview: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      {sequences.map((sequence) => (
        <div className={styles.sequenceRow} key={sequence.id}>
          <span>
            <strong>{sequence.name}</strong>
            <small>
              {sequence.steps.length}
              {t("pageList.timing.workflow.stage")}
            </small>
          </span>
          <Button size="sm" onClick={() => onPreview(sequence.id)}>
            {t("batchEditorCopy.preview")}
          </Button>
          <IconButton
            size="sm"
            label={t("batchEditorMessages.edit", {
              p0: sequence.name,
            })}
            onClick={() => onEdit(sequence)}
          >
            <IconEdit size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("batchEditorMessages.duplicate", {
              p0: sequence.name,
            })}
            onClick={() => onEdit(sequence, true)}
          >
            <IconCopy size={14} />
          </IconButton>
          <IconButton
            size="sm"
            variant="danger"
            label={t("batchEditorMessages.delete", {
              p0: sequence.name,
            })}
            onClick={() => onDelete(sequence.id)}
          >
            <IconTrash size={14} />
          </IconButton>
        </div>
      ))}
    </>
  );
}

export function ConditionalBatchSequenceRunCard(
  props: ConditionalBatchSequenceRunCardProps,
): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const sequence = props.activeSequence;
  if (!sequence) return null;
  const previewByStep = new Map(
    props.sequencePreview?.steps.map((step) => [step.stepId, step.preview]),
  );
  return (
    <section className={styles.schemeCard}>
      <header className={styles.sequenceRunHeader}>
        <span>
          <small>{t("batchEditorCopy.sequence")}</small>
          <strong>{sequence.name}</strong>
        </span>
        <Button size="sm" variant="ghost" onClick={props.onExitSequence}>
          {t("batchEditorCopy.backToRuleEditing")}
        </Button>
      </header>
      <ol className={styles.sequenceRunSteps}>
        {sequence.steps.map((step) => {
          const scheme = props.savedSchemes.find(
            (entry) => entry.id === step.schemeId,
          );
          const preview = previewByStep.get(step.id);
          return (
            <li key={step.id} data-enabled={step.enabled}>
              <span>{scheme?.name ?? step.schemeId}</span>
              <small>
                {step.enabled
                  ? t("batchEditorMessages.results", {
                      p0: preview?.results.length ?? 0,
                    })
                  : t("transform.inactive")}
              </small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
