import { useTranslation } from "react-i18next";
import { IconTrash } from "@tabler/icons-react";

import type { ConditionalBatchField } from "../../../shared/conditionalBatchFieldRegistry";

import {
  createConditionalBatchClientId,
  type ConditionalBatchConditionGroupV2,
  type ConditionalBatchPreviewResult,
} from "../../../shared/conditionalBatchRules";

import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";

import { SegmentedControl } from "./ui/SegmentedControl";

import styles from "./ConditionalBatchEditor.module.css";

import { ConditionCard } from "./ConditionalBatchConditionEditor";

import { moveArrayItem } from "./conditionalBatchConditionModel";

import { FieldPicker } from "./ConditionalBatchConditionFieldPicker";

type ConditionGroupCardProps = {
  activeId: string | null;
  canAdd: boolean;
  currentResult: ConditionalBatchPreviewResult | null;
  group: ConditionalBatchConditionGroupV2;
  onActiveIdChange: (id: string | null) => void;
  onAddCondition: (field: ConditionalBatchField) => void;
  onChange: (group: ConditionalBatchConditionGroupV2) => void;
  onRemove: () => void;
};

export function ConditionGroupCard({
  activeId,
  canAdd,
  currentResult,
  group,
  onActiveIdChange,
  onAddCondition,
  onChange,
  onRemove,
}: ConditionGroupCardProps) {
  useTranslation();
  return (
    <section className={styles.conditionGroup}>
      <ConditionGroupHeader
        group={group}
        onChange={onChange}
        onRemove={onRemove}
      />
      {group.conditions.map((condition, index) => (
        <ConditionCard
          key={condition.id}
          condition={condition}
          currentResult={currentResult}
          expanded={activeId === condition.id}
          index={index}
          total={group.conditions.length}
          canDuplicate={canAdd}
          canRemove={group.conditions.length > 1}
          onChange={(next) =>
            onChange({
              ...group,
              conditions: group.conditions.map((entry) =>
                entry.id === condition.id ? next : entry,
              ),
            })
          }
          onDuplicate={() =>
            onChange({
              ...group,
              conditions: [
                ...group.conditions,
                {
                  ...condition,
                  id: createConditionalBatchClientId("condition"),
                },
              ],
            })
          }
          onExpand={() => onActiveIdChange(condition.id)}
          onMove={(offset) =>
            onChange({
              ...group,
              conditions: moveArrayItem(
                group.conditions,
                index,
                index + offset,
              ),
            })
          }
          onRemove={() =>
            onChange({
              ...group,
              conditions: group.conditions.filter(
                (entry) => entry.id !== condition.id,
              ),
            })
          }
        />
      ))}
      <FieldPicker
        disabled={!canAdd}
        recentFields={group.conditions.map((condition) => condition.field)}
        onAdd={onAddCondition}
      />
    </section>
  );
}

function ConditionGroupHeader({
  group,
  onChange,
  onRemove,
}: {
  group: ConditionalBatchConditionGroupV2;
  onChange: (group: ConditionalBatchConditionGroupV2) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("components");
  return (
    <header>
      <CheckboxField
        checked={group.enabled}
        label={t("batchEditorCopy.conditionGroup")}
        onCheckedChange={(enabled) => onChange({ ...group, enabled })}
      />
      <SegmentedControl
        ariaLabel={t("batchEditorCopy.combineGroupConditions")}
        singleRow
        value={group.logic}
        options={[
          {
            id: "all",
            label: t("batchEditorCopy.all"),
          },
          {
            id: "any",
            label: t("batchEditorCopy.any"),
          },
        ]}
        onChange={(logic) => onChange({ ...group, logic })}
      />
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("batchEditorCopy.deleteConditionGroup")}
        iconLeft={<IconTrash size={14} />}
        onClick={onRemove}
      />
    </header>
  );
}
