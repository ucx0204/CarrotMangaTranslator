/* eslint-disable complexity, max-lines, max-lines-per-function -- the condition card keeps typed values, groups, and bounded editor mutations on one registry contract */
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import React from "react";
import type {
  ConditionalBatchField,
  ConditionalBatchOperator,
} from "../../../shared/conditionalBatchFieldRegistry";
import {
  MAX_CONDITIONAL_BATCH_CONDITIONS,
  createConditionalBatchClientId,
  type ConditionalBatchConditionGroupV2,
  type ConditionalBatchConditionV2,
  type ConditionalBatchPreviewResult,
  type ConditionalBatchSchemeDraftV2,
} from "../../../shared/conditionalBatchRules";
import {
  CONDITIONAL_BATCH_FIELD_LABELS,
  CONDITIONAL_BATCH_OPERATOR_LABELS,
  QUICK_CONDITIONAL_BATCH_FIELDS,
  conditionValueForOperator,
  conditionalBatchEnumOptions,
  createConditionForField,
  listConditionalBatchFields,
  summarizeCondition,
} from "./conditionalBatchUi";
import { Button, CheckboxField, Select } from "./ConditionalBatchControls";
import { FontSelect } from "./FontSelect";
import { useFonts } from "../fonts/useFonts";
import { Field, TextField } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { ConditionalPatternBuilder } from "./ConditionalPatternBuilder";
import styles from "./ConditionalBatchEditor.module.css";

export type ConditionalBatchConditionsCardProps = {
  currentResult: ConditionalBatchPreviewResult | null;
  draft: ConditionalBatchSchemeDraftV2;
  expanded: boolean;
  ruleId: string;
  onChangeDraft: (draft: ConditionalBatchSchemeDraftV2) => void;
  onToggle: () => void;
};

type ConditionalMatchMemory = Pick<
  ConditionalBatchSchemeDraftV2["match"],
  "conditions" | "groups"
>;

export function ConditionalBatchConditionsCard(
  props: ConditionalBatchConditionsCardProps,
): React.JSX.Element {
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
    <section className={styles.ruleCard} data-expanded={props.expanded}>
      <button
        type="button"
        className={styles.cardToggle}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        {props.expanded ? (
          <IconChevronDown size={17} />
        ) : (
          <IconChevronRight size={17} />
        )}
        <span>
          <strong>대상 조건</strong>
          {!props.expanded ? (
            <small>
              {props.draft.match.mode === "allBlocks"
                ? "모든 말풍선"
                : `${props.draft.match.mode === "all" ? "모두" : "하나라도"} · ${conditionCount}개`}
            </small>
          ) : null}
        </span>
      </button>
      {props.expanded ? (
        <div className={styles.cardBody}>
          <SegmentedControl
            ariaLabel="조건 결합 방식"
            options={[
              { id: "all", label: "모두 맞을 때" },
              { id: "any", label: "하나라도 맞을 때" },
              { id: "allBlocks", label: "모든 말풍선" },
            ]}
            value={props.draft.match.mode}
            onChange={actions.changeMode}
          />
          {props.draft.match.mode === "allBlocks" ? null : (
            <>
              <div className={styles.conditionList}>
                {props.draft.match.conditions.map((condition, index) => (
                  <ConditionCard
                    key={condition.id}
                    condition={condition}
                    currentResult={props.currentResult}
                    expanded={activeId === condition.id}
                    index={index}
                    total={props.draft.match.conditions.length}
                    canDuplicate={
                      conditionCount < MAX_CONDITIONAL_BATCH_CONDITIONS
                    }
                    canRemove={conditionCount > 1}
                    onChange={(next) =>
                      actions.updateCondition(condition.id, next)
                    }
                    onDuplicate={() => actions.duplicateCondition(condition.id)}
                    onExpand={() => setActiveId(condition.id)}
                    onMove={(offset) =>
                      actions.moveCondition(condition.id, offset)
                    }
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
                조건 그룹 추가
              </Button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function FieldPicker({
  disabled,
  recentFields,
  onAdd,
}: {
  disabled: boolean;
  recentFields: readonly ConditionalBatchField[];
  onAdd: (field: ConditionalBatchField) => void;
}) {
  const [selected, setSelected] =
    React.useState<ConditionalBatchField>("translatedText");
  const quickFields = [...recentFields, ...QUICK_CONDITIONAL_BATCH_FIELDS]
    .filter((field, index, all) => all.indexOf(field) === index)
    .slice(0, 5);
  return (
    <details className={styles.addMenu}>
      <summary>
        <IconPlus size={15} />
        조건 추가
      </summary>
      <div className={styles.fieldPicker}>
        <div className={styles.quickFields}>
          {quickFields.map((field) => (
            <Button
              key={field}
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onAdd(field)}
            >
              {CONDITIONAL_BATCH_FIELD_LABELS[field]}
            </Button>
          ))}
        </div>
        <div className={styles.fieldPickerAll}>
          <Select
            ariaLabel="추가할 조건 필드"
            searchable
            searchPlaceholder="조건 필드 검색"
            disabled={disabled}
            value={selected}
            options={listConditionalBatchFields().map((field) => ({
              value: field.id,
              label: field.label,
              group: field.categoryLabel,
              searchText: `${field.label} ${field.id} ${field.categoryLabel}`,
            }))}
            onValueChange={(value) =>
              setSelected(value as ConditionalBatchField)
            }
          />
          <Button size="sm" disabled={disabled} onClick={() => onAdd(selected)}>
            추가
          </Button>
        </div>
      </div>
    </details>
  );
}

function ConditionCard({
  condition,
  currentResult,
  expanded,
  index,
  total,
  onChange,
  onDuplicate,
  onExpand,
  onMove,
  onRemove,
  canDuplicate = true,
  canRemove = true,
}: {
  condition: ConditionalBatchConditionV2;
  currentResult: ConditionalBatchPreviewResult | null;
  expanded: boolean;
  index: number;
  total: number;
  onChange: (condition: ConditionalBatchConditionV2) => void;
  onDuplicate: () => void;
  onExpand: () => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
  canDuplicate?: boolean;
  canRemove?: boolean;
}) {
  const { options: fontOptions } = useFonts();
  const evaluation = currentResult?.conditionEvaluations.find(
    (entry) => entry.conditionId === condition.id,
  );
  const fontLabel =
    condition.field === "fontFamily"
      ? (fontOptions.find((font) => font.id === condition.value)?.label ??
        (condition.value ? String(condition.value) : "기본"))
      : undefined;
  return (
    <article
      className={styles.sentenceCard}
      data-enabled={condition.enabled}
      data-expanded={expanded}
    >
      <div className={styles.sentenceHeader}>
        <CheckboxField
          checked={condition.enabled}
          ariaLabel={`${index + 1}번 조건 활성화`}
          onCheckedChange={(enabled) => onChange({ ...condition, enabled })}
        />
        <button
          type="button"
          className={styles.sentenceSummary}
          aria-expanded={expanded}
          onClick={onExpand}
        >
          <span>
            {expanded
              ? CONDITIONAL_BATCH_FIELD_LABELS[condition.field]
              : summarizeCondition(condition, fontLabel)}
          </span>
          {!expanded && evaluation ? (
            <small data-matched={evaluation.matched}>
              {evaluation.matched ? "통과" : "불일치"} ·{" "}
              {evaluation.actualValue}
            </small>
          ) : null}
        </button>
        <div className={styles.rowActions}>
          {total > 1 ? (
            <>
              <IconButton
                size="sm"
                label="조건 위로 이동"
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <IconArrowUp size={14} />
              </IconButton>
              <IconButton
                size="sm"
                label="조건 아래로 이동"
                disabled={index === total - 1}
                onClick={() => onMove(1)}
              >
                <IconArrowDown size={14} />
              </IconButton>
            </>
          ) : null}
          <IconButton
            size="sm"
            label={`${index + 1}번 조건 복제`}
            disabled={!canDuplicate}
            onClick={onDuplicate}
          >
            <IconCopy size={14} />
          </IconButton>
          <IconButton
            size="sm"
            variant="danger"
            label={`${index + 1}번 조건 삭제`}
            disabled={!canRemove}
            onClick={onRemove}
          >
            <IconTrash size={14} />
          </IconButton>
        </div>
      </div>
      {expanded ? (
        <ConditionEditor
          condition={condition}
          sampleText={evaluation?.actualValue}
          onChange={onChange}
        />
      ) : null}
    </article>
  );
}

function ConditionEditor({
  condition,
  sampleText,
  onChange,
}: {
  condition: ConditionalBatchConditionV2;
  sampleText?: string;
  onChange: (condition: ConditionalBatchConditionV2) => void;
}) {
  const definition = listConditionalBatchFields().find(
    (field) => field.id === condition.field,
  );
  if (!definition) return null;
  return (
    <div className={styles.inlineEditor}>
      <div className={styles.conditionControls}>
        <Field as="div" label="필드">
          <Select
            ariaLabel="조건 필드"
            searchable
            value={condition.field}
            options={listConditionalBatchFields().map((field) => ({
              value: field.id,
              label: field.label,
              group: field.categoryLabel,
              searchText: `${field.label} ${field.id} ${field.categoryLabel}`,
            }))}
            onValueChange={(field) =>
              onChange({
                ...createConditionForField(field as ConditionalBatchField),
                id: condition.id,
                enabled: condition.enabled,
                note: condition.note,
              })
            }
          />
        </Field>
        <Field as="div" label="비교">
          <Select
            ariaLabel="비교 방법"
            value={condition.operator}
            options={conditionOperators(condition).map((operator) => ({
              value: operator,
              label: CONDITIONAL_BATCH_OPERATOR_LABELS[operator],
            }))}
            onValueChange={(operator) =>
              onChange(
                conditionValueForOperator(
                  condition,
                  operator as ConditionalBatchOperator,
                ),
              )
            }
          />
        </Field>
      </div>
      <ConditionValueEditor
        condition={condition}
        sampleText={sampleText}
        onChange={onChange}
      />
      <TextField
        label="메모"
        placeholder="선택 사항"
        value={condition.note ?? ""}
        maxLength={500}
        onChange={(event) =>
          onChange({
            ...condition,
            note: event.target.value || undefined,
          })
        }
      />
    </div>
  );
}

function ConditionValueEditor({
  condition,
  sampleText,
  onChange,
}: {
  condition: ConditionalBatchConditionV2;
  sampleText?: string;
  onChange: (condition: ConditionalBatchConditionV2) => void;
}) {
  if (
    (condition.operator === "regex" || condition.operator === "notRegex") &&
    condition.matcher
  ) {
    return (
      <ConditionalPatternBuilder
        matcher={condition.matcher}
        sampleText={sampleText}
        onChangeMatcher={(matcher) => onChange({ ...condition, matcher })}
      />
    );
  }
  if (["empty", "notEmpty", "isTrue", "isFalse"].includes(condition.operator)) {
    return null;
  }
  const definition = listConditionalBatchFields().find(
    (field) => field.id === condition.field,
  );
  const enumOptions = conditionalBatchEnumOptions(condition.field);
  if (condition.field === "fontFamily") {
    return (
      <Field as="div" label="글꼴">
        <FontSelect
          ariaLabel="글꼴 조건 값"
          value={String(condition.value ?? "") || undefined}
          onChange={(fontFamily) =>
            onChange({ ...condition, value: fontFamily ?? "" })
          }
        />
      </Field>
    );
  }
  if (
    definition?.kind === "enum" &&
    condition.operator !== "oneOf" &&
    condition.operator !== "notOneOf"
  ) {
    return (
      <Field as="div" label="값">
        <Select
          ariaLabel="조건 값"
          value={String(condition.value ?? "")}
          options={enumOptions}
          onValueChange={(value) => onChange({ ...condition, value })}
        />
      </Field>
    );
  }
  if (condition.operator === "oneOf" || condition.operator === "notOneOf") {
    const selected = new Set(
      Array.isArray(condition.value) ? condition.value : [],
    );
    return (
      <div className={styles.multiValueGrid}>
        {enumOptions.map((option) => (
          <CheckboxField
            key={option.value}
            checked={selected.has(option.value)}
            label={option.label}
            onCheckedChange={(checked) => {
              const next = new Set(selected);
              if (checked) next.add(option.value);
              else next.delete(option.value);
              onChange({
                ...condition,
                value: [...next].length ? [...next] : [option.value],
              });
            }}
          />
        ))}
      </div>
    );
  }
  if (definition?.kind === "number") {
    return (
      <div className={styles.valuePair}>
        <Field label={condition.operator === "between" ? "최솟값" : "값"}>
          <input
            type="number"
            step="any"
            value={typeof condition.value === "number" ? condition.value : 0}
            onChange={(event) =>
              onChange({ ...condition, value: Number(event.target.value) })
            }
          />
        </Field>
        {condition.operator === "between" ? (
          <Field label="최댓값">
            <input
              type="number"
              step="any"
              value={condition.value2 ?? 1}
              onChange={(event) =>
                onChange({ ...condition, value2: Number(event.target.value) })
              }
            />
          </Field>
        ) : null}
      </div>
    );
  }
  if (definition?.kind === "color") {
    return (
      <div className={styles.valuePair}>
        <Field label="색">
          <input
            type="color"
            value={String(condition.value ?? "#000000")}
            onChange={(event) =>
              onChange({ ...condition, value: event.target.value })
            }
          />
        </Field>
        {condition.operator === "near" ? (
          <Field label="허용 오차">
            <input
              type="number"
              min={0}
              max={100}
              value={condition.tolerance ?? 10}
              onChange={(event) =>
                onChange({
                  ...condition,
                  tolerance: Number(event.target.value),
                })
              }
            />
          </Field>
        ) : null}
      </div>
    );
  }
  return (
    <Field label="값">
      <input
        placeholder="비교할 값"
        value={String(condition.value ?? "")}
        onChange={(event) =>
          onChange({ ...condition, value: event.target.value })
        }
      />
    </Field>
  );
}

function ConditionGroupCard({
  activeId,
  canAdd,
  currentResult,
  group,
  onActiveIdChange,
  onAddCondition,
  onChange,
  onRemove,
}: {
  activeId: string | null;
  canAdd: boolean;
  currentResult: ConditionalBatchPreviewResult | null;
  group: ConditionalBatchConditionGroupV2;
  onActiveIdChange: (id: string | null) => void;
  onAddCondition: (field: ConditionalBatchField) => void;
  onChange: (group: ConditionalBatchConditionGroupV2) => void;
  onRemove: () => void;
}) {
  return (
    <section className={styles.conditionGroup}>
      <header>
        <CheckboxField
          checked={group.enabled}
          label="조건 그룹"
          onCheckedChange={(enabled) => onChange({ ...group, enabled })}
        />
        <SegmentedControl
          ariaLabel="그룹 조건 결합"
          singleRow
          value={group.logic}
          options={[
            { id: "all", label: "모두" },
            { id: "any", label: "하나라도" },
          ]}
          onChange={(logic) => onChange({ ...group, logic })}
        />
        <Button
          size="sm"
          variant="ghost"
          aria-label="조건 그룹 삭제"
          iconLeft={<IconTrash size={14} />}
          onClick={onRemove}
        />
      </header>
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

function createConditionActions(
  { draft, onChangeDraft, ruleId }: ConditionalBatchConditionsCardProps,
  setActiveId: (id: string | null) => void,
  conditionMemory: ReadonlyMap<string, ConditionalMatchMemory>,
  rememberConditions: (ruleId: string, memory: ConditionalMatchMemory) => void,
) {
  const commitMatch = (match: ConditionalBatchSchemeDraftV2["match"]): void =>
    onChangeDraft({ ...draft, match });
  const changeMode = (
    mode: ConditionalBatchSchemeDraftV2["match"]["mode"],
  ): void => {
    if (mode === "allBlocks") {
      if (draft.match.mode !== "allBlocks") {
        rememberConditions(ruleId, {
          conditions: draft.match.conditions,
          groups: draft.match.groups,
        });
      }
      commitMatch({ mode, conditions: [], groups: [] });
      return;
    }
    const source =
      draft.match.mode === "allBlocks"
        ? conditionMemory.get(ruleId)
        : draft.match;
    const conditions =
      source && (source.conditions.length || source.groups.length)
        ? source.conditions
        : [createConditionForField("translatedText")];
    commitMatch({
      mode,
      conditions,
      groups: source?.groups ?? [],
    });
  };
  const addCondition = (
    field: ConditionalBatchField,
    groupId?: string,
  ): void => {
    if (countConditions(draft) >= MAX_CONDITIONAL_BATCH_CONDITIONS) return;
    const condition = createConditionForField(field);
    if (groupId) {
      commitMatch({
        ...draft.match,
        groups: draft.match.groups.map((group) =>
          group.id === groupId
            ? { ...group, conditions: [...group.conditions, condition] }
            : group,
        ),
      });
    } else {
      commitMatch({
        ...draft.match,
        conditions: [...draft.match.conditions, condition],
      });
    }
    setActiveId(condition.id);
  };
  const updateCondition = (
    id: string,
    next: ConditionalBatchConditionV2,
  ): void =>
    commitMatch({
      ...draft.match,
      conditions: draft.match.conditions.map((condition) =>
        condition.id === id ? { ...next, id } : condition,
      ),
    });
  const removeCondition = (id: string): void =>
    commitMatch({
      ...draft.match,
      conditions: draft.match.conditions.filter(
        (condition) => condition.id !== id,
      ),
    });
  const duplicateCondition = (id: string): void => {
    const source = draft.match.conditions.find(
      (condition) => condition.id === id,
    );
    if (!source || countConditions(draft) >= MAX_CONDITIONAL_BATCH_CONDITIONS) {
      return;
    }
    const duplicate = {
      ...source,
      id: createConditionalBatchClientId("condition"),
    };
    const index = draft.match.conditions.indexOf(source);
    const conditions = [...draft.match.conditions];
    conditions.splice(index + 1, 0, duplicate);
    commitMatch({ ...draft.match, conditions });
    setActiveId(duplicate.id);
  };
  const moveCondition = (id: string, offset: -1 | 1): void => {
    const index = draft.match.conditions.findIndex(
      (condition) => condition.id === id,
    );
    commitMatch({
      ...draft.match,
      conditions: moveArrayItem(draft.match.conditions, index, index + offset),
    });
  };
  const addGroup = (): void => {
    if (countConditions(draft) >= MAX_CONDITIONAL_BATCH_CONDITIONS) return;
    const condition = createConditionForField("translatedText");
    const group: ConditionalBatchConditionGroupV2 = {
      id: createConditionalBatchClientId("group"),
      enabled: true,
      logic: "all",
      conditions: [condition],
    };
    commitMatch({ ...draft.match, groups: [...draft.match.groups, group] });
    setActiveId(condition.id);
  };
  const updateGroup = (
    id: string,
    next: ConditionalBatchConditionGroupV2,
  ): void =>
    commitMatch({
      ...draft.match,
      groups: draft.match.groups.map((group) =>
        group.id === id ? { ...next, id } : group,
      ),
    });
  const removeGroup = (id: string): void =>
    commitMatch({
      ...draft.match,
      groups: draft.match.groups.filter((group) => group.id !== id),
    });
  return {
    addCondition,
    addGroup,
    changeMode,
    duplicateCondition,
    moveCondition,
    removeCondition,
    removeGroup,
    updateCondition,
    updateGroup,
  };
}

function conditionOperators(
  condition: ConditionalBatchConditionV2,
): readonly ConditionalBatchOperator[] {
  const definition = listConditionalBatchFields().find(
    (field) => field.id === condition.field,
  );
  if (!definition) return [];
  if (condition.field !== "fontFamily") return definition.operators;
  const preferred: readonly ConditionalBatchOperator[] = [
    "equals",
    "notEquals",
    "empty",
    "notEmpty",
  ];
  return preferred.includes(condition.operator)
    ? preferred
    : [...preferred, condition.operator];
}

function moveArrayItem<T>(values: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || to >= values.length) return [...values];
  const next = [...values];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function countConditions(draft: ConditionalBatchSchemeDraftV2): number {
  return (
    draft.match.conditions.length +
    draft.match.groups.reduce(
      (count, group) => count + group.conditions.length,
      0,
    )
  );
}
