import { IconCopy, IconEdit, IconTrash } from "@tabler/icons-react";
import React from "react";
import type { ConditionalBatchSequenceV2 } from "../../../shared/conditionalBatchRules";
import type { ConditionalBatchRulePanelProps } from "./conditionalBatchRulePanelTypes";
import {
  Button,
  ConditionalBatchCollapsibleTrigger,
} from "./ConditionalBatchControls";
import { ConditionalBatchSequenceForm } from "./ConditionalBatchSequenceForm";
import { IconButton } from "./ui/IconButton";
import { useConditionalBatchSequenceEditor } from "./useConditionalBatchSequenceEditor";
import styles from "./ConditionalBatchEditor.module.css";

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
  const bodyId = React.useId();
  const editor = useConditionalBatchSequenceEditor(
    props.savedSchemes,
    props.onSaveSequence,
  );
  return (
    <section className={styles.sequenceManager} data-expanded={props.expanded}>
      <header className={styles.sequenceHeader}>
        <ConditionalBatchCollapsibleTrigger
          bodyId={bodyId}
          expanded={props.expanded}
          title="연속 실행"
          onToggle={props.onToggle}
        />
        {props.expanded ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.savedSchemes.length === 0}
            onClick={editor.startNew}
          >
            새 연속 실행
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
              onSave={editor.save}
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
  return (
    <>
      {sequences.map((sequence) => (
        <div className={styles.sequenceRow} key={sequence.id}>
          <span>
            <strong>{sequence.name}</strong>
            <small>{sequence.steps.length}단계</small>
          </span>
          <Button size="sm" onClick={() => onPreview(sequence.id)}>
            미리보기
          </Button>
          <IconButton
            size="sm"
            label={`${sequence.name} 편집`}
            onClick={() => onEdit(sequence)}
          >
            <IconEdit size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={`${sequence.name} 복제`}
            onClick={() => onEdit(sequence, true)}
          >
            <IconCopy size={14} />
          </IconButton>
          <IconButton
            size="sm"
            variant="danger"
            label={`${sequence.name} 삭제`}
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
  const sequence = props.activeSequence;
  if (!sequence) return null;
  const previewByStep = new Map(
    props.sequencePreview?.steps.map((step) => [step.stepId, step.preview]),
  );
  return (
    <section className={styles.schemeCard}>
      <header className={styles.sequenceRunHeader}>
        <span>
          <small>연속 실행</small>
          <strong>{sequence.name}</strong>
        </span>
        <Button size="sm" variant="ghost" onClick={props.onExitSequence}>
          규칙 편집으로 돌아가기
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
                  ? `${preview?.results.length ?? 0}개 결과`
                  : "사용 안 함"}
              </small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
