import React from "react";
import type {
  ConditionalBatchSchemeV2,
  ConditionalBatchSequenceV2,
} from "../../../shared/conditionalBatchRules";
import { createConditionalBatchSequenceItemId } from "./conditionalBatchSequenceModel";

export function useConditionalBatchSequenceEditor(
  savedSchemes: readonly ConditionalBatchSchemeV2[],
  onSaveSequence: (sequence: ConditionalBatchSequenceV2) => Promise<boolean>,
) {
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("연속 실행");
  const [description, setDescription] = React.useState("");
  const [steps, setSteps] = React.useState<ConditionalBatchSequenceV2["steps"]>(
    [],
  );
  const [schemeToAdd, setSchemeToAdd] = React.useState(
    savedSchemes[0]?.id ?? "",
  );

  React.useEffect(() => {
    if (!savedSchemes.some((scheme) => scheme.id === schemeToAdd)) {
      setSchemeToAdd(savedSchemes[0]?.id ?? "");
    }
  }, [savedSchemes, schemeToAdd]);

  const reset = (): void => {
    setFormOpen(false);
    setEditingId(null);
    setName("연속 실행");
    setDescription("");
    setSteps([]);
  };
  const { saving, saveSequence } = useSequenceSave(onSaveSequence, reset);
  const edit = (
    sequence: ConditionalBatchSequenceV2,
    duplicate = false,
  ): void => {
    setFormOpen(true);
    setEditingId(duplicate ? null : sequence.id);
    setName(duplicate ? `${sequence.name} 복사본`.slice(0, 80) : sequence.name);
    setDescription(sequence.description);
    setSteps(
      sequence.steps.map((step) => ({
        ...step,
        id: duplicate ? createConditionalBatchSequenceItemId("step") : step.id,
      })),
    );
  };
  const startNew = (): void => {
    reset();
    setFormOpen(true);
  };
  const save = async (): Promise<void> => {
    if (!canSaveSequence(name, steps)) {
      return;
    }
    await saveSequence({
      id: editingId ?? createConditionalBatchSequenceItemId("sequence"),
      name: name.trim(),
      description: description.trim(),
      steps,
    });
  };

  return {
    description,
    editingId,
    edit,
    formOpen,
    name,
    reset,
    save,
    saving,
    schemeToAdd,
    setDescription,
    setName,
    setSchemeToAdd,
    setSteps,
    startNew,
    steps,
  };
}

function useSequenceSave(
  onSave: (sequence: ConditionalBatchSequenceV2) => Promise<boolean>,
  onSaved: () => void,
) {
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const saveSequence = async (
    sequence: ConditionalBatchSequenceV2,
  ): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (await onSave(sequence)) onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return { saving, saveSequence };
}

function canSaveSequence(
  name: string,
  steps: ConditionalBatchSequenceV2["steps"],
): boolean {
  return (
    Boolean(name.trim()) &&
    steps.length > 0 &&
    steps.some((step) => step.enabled)
  );
}
