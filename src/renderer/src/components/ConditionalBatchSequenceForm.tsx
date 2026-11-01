import { useTranslation } from "react-i18next";
import {
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconTrash,
} from "@tabler/icons-react";
import React from "react";
import type {
  ConditionalBatchSchemeV2,
  ConditionalBatchSequenceV2,
} from "../../../shared/conditionalBatchRules";
import styles from "./ConditionalBatchEditor.module.css";
import {
  createConditionalBatchSequenceItemId,
  moveConditionalBatchSequenceItem,
} from "./conditionalBatchSequenceModel";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { TextareaField, TextField } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { Select } from "./ui/Select";

type SequenceSteps = ConditionalBatchSequenceV2["steps"];

type ConditionalBatchSequenceFormProps = {
  description: string;
  editingId: string | null;
  name: string;
  savedSchemes: readonly ConditionalBatchSchemeV2[];
  schemeToAdd: string;
  steps: SequenceSteps;
  setDescription: React.Dispatch<React.SetStateAction<string>>;
  setName: React.Dispatch<React.SetStateAction<string>>;
  setSchemeToAdd: React.Dispatch<React.SetStateAction<string>>;
  setSteps: React.Dispatch<React.SetStateAction<SequenceSteps>>;
  onCancel: () => void;
  onSave: () => void;
};

export function ConditionalBatchSequenceForm(
  props: ConditionalBatchSequenceFormProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const schemeOptions = props.savedSchemes.map((scheme) => ({
    value: scheme.id,
    label: scheme.name,
  }));
  const canSave =
    Boolean(props.name.trim()) &&
    props.steps.length > 0 &&
    props.steps.some((step) => step.enabled);
  return (
    <div className={styles.sequenceForm}>
      <TextField
        label={t("batchEditorCopy.sequenceName")}
        value={props.name}
        maxLength={80}
        onChange={(event) => props.setName(event.target.value)}
      />
      <TextareaField
        label={t("batchEditorCopy.description")}
        rows={2}
        maxLength={500}
        value={props.description}
        onChange={(event) => props.setDescription(event.target.value)}
      />
      <SequenceStepList
        options={schemeOptions}
        steps={props.steps}
        setSteps={props.setSteps}
      />
      {props.savedSchemes.length ? (
        <div className={styles.fieldPickerAll}>
          <Select
            ariaLabel={t("batchEditorCopy.ruleToAddToSequence")}
            value={props.schemeToAdd}
            options={schemeOptions}
            onValueChange={props.setSchemeToAdd}
          />
          <Button
            size="sm"
            disabled={!props.schemeToAdd || props.steps.length >= 32}
            onClick={() => addStep(props)}
          >
            {t("batchEditorCopy.addStep")}
          </Button>
        </div>
      ) : null}
      <div className={styles.sequenceFormActions}>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" disabled={!canSave} onClick={props.onSave}>
          {props.editingId ? t("batchEditorCopy.update") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function SequenceStepList({
  options,
  steps,
  setSteps,
}: {
  options: readonly { label: string; value: string }[];
  steps: SequenceSteps;
  setSteps: React.Dispatch<React.SetStateAction<SequenceSteps>>;
}): React.JSX.Element {
  useTranslation();
  return (
    <div className={styles.sequenceSteps}>
      {steps.map((step, index) => (
        <SequenceStepRow
          key={step.id}
          index={index}
          options={options}
          step={step}
          stepCount={steps.length}
          setSteps={setSteps}
        />
      ))}
    </div>
  );
}

function SequenceStepRow({
  index,
  options,
  step,
  stepCount,
  setSteps,
}: {
  index: number;
  options: readonly { label: string; value: string }[];
  step: SequenceSteps[number];
  stepCount: number;
  setSteps: React.Dispatch<React.SetStateAction<SequenceSteps>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateStep = (patch: Partial<SequenceSteps[number]>): void => {
    setSteps((current) =>
      current.map((entry) =>
        entry.id === step.id ? { ...entry, ...patch } : entry,
      ),
    );
  };
  return (
    <div className={styles.sequenceStepRow}>
      <CheckboxField
        checked={step.enabled}
        ariaLabel={t("batchEditorMessages.enableSequenceStep", {
          p0: index + 1,
        })}
        onCheckedChange={(enabled) => updateStep({ enabled })}
      />
      <span>{index + 1}</span>
      <Select
        ariaLabel={t("batchEditorMessages.sequenceRule", {
          p0: index + 1,
        })}
        value={step.schemeId}
        options={options}
        onValueChange={(schemeId) => updateStep({ schemeId })}
      />
      <SequenceStepActions
        index={index}
        step={step}
        stepCount={stepCount}
        setSteps={setSteps}
      />
    </div>
  );
}

function SequenceStepActions({
  index,
  step,
  stepCount,
  setSteps,
}: {
  index: number;
  step: SequenceSteps[number];
  stepCount: number;
  setSteps: React.Dispatch<React.SetStateAction<SequenceSteps>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.sequenceStepActions}>
      <IconButton
        size="sm"
        label={t("batchEditorCopy.moveSequenceStepUp")}
        disabled={index === 0}
        onClick={() =>
          setSteps((current) =>
            moveConditionalBatchSequenceItem(current, index, index - 1),
          )
        }
      >
        <IconArrowUp size={14} />
      </IconButton>
      <IconButton
        size="sm"
        label={t("batchEditorCopy.moveSequenceStepDown")}
        disabled={index === stepCount - 1}
        onClick={() =>
          setSteps((current) =>
            moveConditionalBatchSequenceItem(current, index, index + 1),
          )
        }
      >
        <IconArrowDown size={14} />
      </IconButton>
      <IconButton
        size="sm"
        label={t("batchEditorCopy.duplicateSequenceStep")}
        disabled={stepCount >= 32}
        onClick={() => duplicateStep(setSteps, step, index)}
      >
        <IconCopy size={14} />
      </IconButton>
      <IconButton
        size="sm"
        variant="danger"
        label={t("batchEditorCopy.deleteSequenceStep")}
        onClick={() =>
          setSteps((current) => current.filter((entry) => entry.id !== step.id))
        }
      >
        <IconTrash size={14} />
      </IconButton>
    </div>
  );
}

function addStep(props: ConditionalBatchSequenceFormProps): void {
  if (!props.schemeToAdd) return;
  props.setSteps((current) => [
    ...current,
    {
      id: createConditionalBatchSequenceItemId("step"),
      schemeId: props.schemeToAdd,
      enabled: true,
    },
  ]);
}

function duplicateStep(
  setSteps: React.Dispatch<React.SetStateAction<SequenceSteps>>,
  step: SequenceSteps[number],
  index: number,
): void {
  setSteps((current) => {
    const next = [...current];
    next.splice(index + 1, 0, {
      ...step,
      id: createConditionalBatchSequenceItemId("step"),
    });
    return next;
  });
}
