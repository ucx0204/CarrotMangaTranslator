import { useTranslation } from "react-i18next";

import React from "react";
import { getConditionalBatchFieldDefinition } from "../../../shared/conditionalBatchFieldRegistry";
import type { ConditionalBatchSetFieldChangeV2 } from "../../../shared/conditionalBatchRules";

import { resolveConditionalBatchNumberPresentation } from "./conditionalBatchPresentation";

import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchLabels";
import { Field } from "./ui/Field";

import { NumberField } from "./ui/NumberField";

export function NumberSetFieldValue({
  change,
  onChange,
}: {
  change: ConditionalBatchSetFieldChangeV2;
  onChange: (change: ConditionalBatchSetFieldChangeV2) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const definition = getConditionalBatchFieldDefinition(change.field);
  const fallback = definition.number?.defaultValue ?? 0;
  const presentation = resolveConditionalBatchNumberPresentation(
    change.field,
    typeof change.value === "number" ? change.value : fallback,
  );
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];
  return (
    <Field
      label={t("batchEditorCopy.valueToApply")}
      hint={t("batchEditorMessages.range", {
        p0: presentation.min,
        p1: presentation.unit,
        p2: presentation.max,
        p3: presentation.unit,
      })}
    >
      <NumberField
        ariaLabel={t("batchEditorMessages.valueFor", {
          p0: label,
        })}
        variant="framed"
        min={presentation.min}
        max={presentation.max}
        step={presentation.step}
        precision={6}
        unit={presentation.unit}
        value={presentation.value}
        onValueChange={(value) =>
          onChange({ ...change, value: presentation.toStoredValue(value) })
        }
      />
    </Field>
  );
}
