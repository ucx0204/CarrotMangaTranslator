import { useTranslation } from "react-i18next";
import { appI18n } from "../appI18n";
import { IconPlus } from "@tabler/icons-react";

import React from "react";

import type { ConditionalBatchField } from "../../../shared/conditionalBatchFieldRegistry";

import {
  MAX_CONDITIONAL_BATCH_CONDITIONS,
  type ConditionalBatchPreviewResult,
  type ConditionalBatchSchemeDraftV2,
} from "../../../shared/conditionalBatchRules";

import { ConditionalBatchCollapsibleCard } from "./ConditionalBatchControls";
import { Button } from "./ui/Button";

import { SegmentedControl } from "./ui/SegmentedControl";

import styles from "./ConditionalBatchEditor.module.css";

import {
  ConditionalMatchMemory,
  countConditions,
  createConditionActions,
} from "./conditionalBatchConditionModel";

import { ConditionCard } from "./ConditionalBatchConditionEditor";

import { ConditionGroupCard } from "./ConditionalBatchConditionGroup";

import { FieldPicker } from "./ConditionalBatchConditionFieldPicker";

const t = appI18n.getFixedT(null, "components");

export type ConditionalBatchConditionsCardProps = {
  currentResult: ConditionalBatchPreviewResult | null;
  draft: ConditionalBatchSchemeDraftV2;
  expanded: boolean;
  ruleId: string;
  onChangeDraft: (draft: ConditionalBatchSchemeDraftV2) => void;
  onToggle: () => void;
};

export function ConditionalBatchConditionsCard(
  props: ConditionalBatchConditionsCardProps,
): React.JSX.Element {
  useTranslation();
  const conditionCount = countConditions(props.draft);
  const [activeId, setActiveId] = React.useState<string | null>(
    props.draft.match.conditions[0]?.id ?? null,
  );
  const [recentFields, setRecentFields] = React.useState<
    ConditionalBatchField[]
  >([]);
  const [conditionMemory, setConditionMemory] = React.useState(
    new Map<string, ConditionalMatchMemory>(),
  );
  React.useEffect(() => {
    const ids = [
      ...props.draft.match.conditions.map((condition) => condition.id),
      ...props.draft.match.groups.flatMap((group) =>
        group.conditions.map((condition) => condition.id),
      ),
    ];
    if (!activeId || !ids.includes(activeId)) {
      setActiveId(ids[0] ?? null);
    }
  }, [activeId, props.draft.match.conditions, props.draft.match.groups]);
  const actions = createConditionActions(
    props,
    setActiveId,
    conditionMemory,
    (ruleId, memory) =>
      setConditionMemory((current) => {
        const next = new Map(current);
        next.set(ruleId, memory);
        return next;
      }),
  );
  const addField = (field: ConditionalBatchField, groupId?: string): void => {
    actions.addCondition(field, groupId);
    setRecentFields((current) =>
      [field, ...current.filter((entry) => entry !== field)].slice(0, 5),
    );
  };
  return (
    <ConditionalBatchCollapsibleCard
      expanded={props.expanded}
      onToggle={props.onToggle}
      title={t("batchEditorCopy.targetConditions")}
      summary={conditionMatchSummary(props.draft, conditionCount)}
    >
      <ConditionMatchMode draft={props.draft} onChange={actions.changeMode} />
      {props.draft.match.mode === "allBlocks" ? null : (
        <>
          <ConditionList
            props={props}
            conditionCount={conditionCount}
            activeId={activeId}
            setActiveId={setActiveId}
            actions={actions}
            addField={addField}
          />
          <FieldPicker
            disabled={conditionCount >= MAX_CONDITIONAL_BATCH_CONDITIONS}
            recentFields={recentFields}
            onAdd={addField}
          />
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<IconPlus size={15} />}
            disabled={conditionCount >= MAX_CONDITIONAL_BATCH_CONDITIONS}
            onClick={actions.addGroup}
          >
            {t("batchEditorCopy.addConditionGroup")}
          </Button>
        </>
      )}
    </ConditionalBatchCollapsibleCard>
  );
}

function ConditionList({
  props,
  conditionCount,
  activeId,
  setActiveId,
  actions,
  addField,
}: {
  props: ConditionalBatchConditionsCardProps;
  conditionCount: number;
  activeId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  actions: ReturnType<typeof createConditionActions>;
  addField: (field: ConditionalBatchField, groupId?: string) => void;
}) {
  useTranslation();
  return (
    <div className={styles.conditionList}>
      {props.draft.match.conditions.map((condition, index) => (
        <ConditionCard
          key={condition.id}
          condition={condition}
          currentResult={props.currentResult}
          expanded={activeId === condition.id}
          index={index}
          total={props.draft.match.conditions.length}
          canDuplicate={conditionCount < MAX_CONDITIONAL_BATCH_CONDITIONS}
          canRemove={conditionCount > 1}
          onChange={(next) => actions.updateCondition(condition.id, next)}
          onDuplicate={() => actions.duplicateCondition(condition.id)}
          onExpand={() => setActiveId(condition.id)}
          onMove={(offset) => actions.moveCondition(condition.id, offset)}
          onRemove={() => actions.removeCondition(condition.id)}
        />
      ))}
      {props.draft.match.groups.map((group) => (
        <ConditionGroupCard
          key={group.id}
          currentResult={props.currentResult}
          group={group}
          activeId={activeId}
          canAdd={conditionCount < MAX_CONDITIONAL_BATCH_CONDITIONS}
          onActiveIdChange={setActiveId}
          onAddCondition={(field) => addField(field, group.id)}
          onChange={(next) => actions.updateGroup(group.id, next)}
          onRemove={() => actions.removeGroup(group.id)}
        />
      ))}
    </div>
  );
}

function ConditionMatchMode({
  draft,
  onChange,
}: {
  draft: ConditionalBatchSchemeDraftV2;
  onChange: (mode: ConditionalBatchSchemeDraftV2["match"]["mode"]) => void;
}) {
  useTranslation();
  return (
    <SegmentedControl
      ariaLabel={t("conditionalBatch.when.modeLabel")}
      options={[
        {
          id: "all",
          label: t("conditionalBatch.when.all"),
        },
        {
          id: "any",
          label: t("conditionalBatch.when.any"),
        },
        {
          id: "allBlocks",
          label: t("conditionalBatch.when.allBlocks"),
        },
      ]}
      value={draft.match.mode}
      onChange={onChange}
    />
  );
}

function conditionMatchSummary(
  draft: ConditionalBatchSchemeDraftV2,
  count: number,
): string {
  return draft.match.mode === "allBlocks"
    ? t("conditionalBatch.when.allBlocks")
    : t("batchEditorMessages.conditions", {
        p0:
          draft.match.mode === "all"
            ? appI18n.t("batchEditorCopy.all", { ns: "components" })
            : appI18n.t("batchEditorCopy.any", { ns: "components" }),
        p1: count,
      });
}
