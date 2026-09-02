/* eslint-disable max-lines, max-lines-per-function -- the action card keeps all stage-aware editors on one discriminated action contract */
import {
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconGripVertical,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import React from "react";
import type { BlockStylePreset } from "../../../shared/blockStylePresets";
import { getConditionalBatchFieldDefinition } from "../../../shared/conditionalBatchFieldRegistry";
import { createConditionalLiteralMatcher } from "../../../shared/conditionalTextPattern";
import {
  MAX_CONDITIONAL_BATCH_ACTIONS,
  CONDITIONAL_BATCH_TEXT_STYLE_FIELDS,
  createConditionalBatchClientId,
  type ConditionalBatchActionV2,
  type ConditionalBatchApplyStylePresetActionV2,
  type ConditionalBatchReplaceTextActionV2,
  type ConditionalBatchPreviewResult,
  type ConditionalBatchSchemeDraftV2,
  type ConditionalBatchSetFieldChangeV2,
  type ConditionalBatchSetFieldsActionV2,
  type ConditionalBatchStyleTextActionV2,
  type ConditionalBatchTextStyleField,
  type ConditionalBatchTextStyleMatchCondition,
  type ConditionalBatchTextStyleOperator,
  type ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";
import {
  stripRichTextMarkup,
  type TextStylePatch,
} from "../../../shared/richTextMarkup";
import {
  CONDITIONAL_BATCH_FIELD_LABELS,
  actionStage,
  conditionalBatchEnumOptions,
  createDefaultAction,
  isNewConditionalBatchWritableField,
  listConditionalBatchFields,
  summarizeAction,
} from "./conditionalBatchUi";
import {
  Button,
  CheckboxField,
  ConditionalBatchCollapsibleCard,
  Select,
} from "./ConditionalBatchControls";
import { FontSelect } from "./FontSelect";
import { ColorField } from "./ColorField";
import { Field, TextField } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { ConditionalPatternBuilder } from "./ConditionalPatternBuilder";
import styles from "./ConditionalBatchEditor.module.css";

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
      title="작업"
      summary={
        props.draft.actions.length === 0
          ? "검사만 수행"
          : `${props.draft.actions.length}개 작업`
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
  const [presetId, setPresetId] = React.useState(presets[0]?.id ?? "");
  return (
    <details className={styles.addMenu}>
      <summary>
        <IconPlus size={15} />
        작업 추가
      </summary>
      <div className={styles.actionAdd}>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onAdd("replaceText")}
        >
          찾아 바꾸기
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => onAdd("setText")}>
          텍스트 전체 바꾸기
        </Button>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onAdd("setFields")}
        >
          속성 바꾸기
        </Button>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onAdd("styleText")}
        >
          글자 일부 서식
        </Button>
        {presets.length ? (
          <div className={styles.presetAdd}>
            <Select
              ariaLabel="적용할 스타일 프리셋"
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
              프리셋 적용
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ActionSentenceCard({
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
}: {
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
}) {
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
      <div className={styles.sentenceHeader}>
        {sameStage.length > 1 ? (
          <span className={styles.dragHandle} aria-hidden="true">
            <IconGripVertical size={16} />
          </span>
        ) : null}
        <CheckboxField
          checked={action.enabled}
          ariaLabel={`${index + 1}번 작업 활성화`}
          onCheckedChange={(enabled) => onChange({ ...action, enabled })}
        />
        <button
          type="button"
          className={styles.sentenceSummary}
          aria-expanded={expanded}
          onClick={onExpand}
        >
          <span>
            {expanded ? actionEditorTitle(action) : summarizeAction(action)}
          </span>
        </button>
        <div className={styles.rowActions}>
          {sameStage.length > 1 ? (
            <>
              <IconButton
                size="sm"
                label="작업 위로 이동"
                disabled={stageIndex <= 0}
                onClick={() => onMove(-1)}
              >
                <IconArrowUp size={14} />
              </IconButton>
              <IconButton
                size="sm"
                label="작업 아래로 이동"
                disabled={stageIndex < 0 || stageIndex >= sameStage.length - 1}
                onClick={() => onMove(1)}
              >
                <IconArrowDown size={14} />
              </IconButton>
            </>
          ) : null}
          <IconButton
            size="sm"
            label={`${index + 1}번 작업 복제`}
            disabled={actions.length >= MAX_CONDITIONAL_BATCH_ACTIONS}
            onClick={onDuplicate}
          >
            <IconCopy size={14} />
          </IconButton>
          <IconButton
            size="sm"
            variant="danger"
            label={`${index + 1}번 작업 삭제`}
            onClick={onRemove}
          >
            <IconTrash size={14} />
          </IconButton>
        </div>
      </div>
      {expanded ? (
        <div className={styles.inlineEditor}>
          <ActionEditor
            action={action}
            currentResult={currentResult}
            presets={blockStylePresets}
            onChange={onChange}
          />
          <TextField
            label="메모"
            placeholder="선택 사항"
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

function actionEditorTitle(action: ConditionalBatchActionV2): string {
  if (action.type === "replaceText") return "찾아 바꾸기";
  if (action.type === "setFields") {
    const textOnly =
      action.changes.length === 1 &&
      ["sourceText", "translatedText"].includes(action.changes[0]?.field ?? "");
    return textOnly ? "텍스트 전체 바꾸기" : "속성 바꾸기";
  }
  if (action.type === "applyStylePreset") return "프리셋 적용";
  return "글자 일부 서식";
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
    return <SetFieldsActionEditor action={action} onChange={onChange} />;
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

function ReplaceActionEditor({
  action,
  sampleText,
  onChange,
}: {
  action: ConditionalBatchReplaceTextActionV2;
  sampleText?: string;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  return (
    <>
      <div className={styles.actionOptions}>
        <Field as="div" label="대상">
          <Select
            ariaLabel="치환할 글"
            value={action.target}
            options={[
              { value: "translatedText", label: "번역문" },
              { value: "sourceText", label: "원문" },
              { value: "both", label: "원문과 번역문" },
            ]}
            onValueChange={(target) =>
              onChange({
                ...action,
                target: target as ConditionalBatchReplaceTextActionV2["target"],
              })
            }
          />
        </Field>
        <Field as="div" label="바꿀 범위">
          <Select
            ariaLabel="바꿀 범위"
            value={action.allOccurrences ? "all" : "first"}
            options={[
              { value: "all", label: "모든 일치 항목" },
              { value: "first", label: "첫 번째만" },
            ]}
            onValueChange={(value) =>
              onChange({ ...action, allOccurrences: value === "all" })
            }
          />
        </Field>
      </div>
      <ConditionalPatternBuilder
        matcher={action.matcher}
        replacement={action.replacement}
        sampleText={sampleText}
        onChangeMatcher={(matcher) => onChange({ ...action, matcher })}
        onChangeReplacement={(replacement) =>
          onChange({ ...action, replacement })
        }
        onSwitchToRaw={(matcher, replacement) =>
          onChange({
            ...action,
            matcher,
            replacement: replacement ?? action.replacement,
          })
        }
        onSwitchToVisual={(matcher, replacement) =>
          onChange({
            ...action,
            matcher,
            replacement: replacement ?? action.replacement,
          })
        }
      />
    </>
  );
}

function SetFieldsActionEditor({
  action,
  onChange,
}: {
  action: ConditionalBatchSetFieldsActionV2;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const existingFields = new Set(action.changes.map((change) => change.field));
  const writableFields = listConditionalBatchFields().filter(
    (field) =>
      field.writable &&
      (existingFields.has(field.id as ConditionalBatchWritableField) ||
        isNewConditionalBatchWritableField(field.id)),
  );
  const unused = writableFields.filter(
    (field) => !action.changes.some((change) => change.field === field.id),
  );
  const [fieldToAdd, setFieldToAdd] =
    React.useState<ConditionalBatchWritableField>(
      (unused[0]?.id as ConditionalBatchWritableField) ?? "translatedText",
    );
  React.useEffect(() => {
    if (!unused.some((field) => field.id === fieldToAdd)) {
      setFieldToAdd(
        (unused[0]?.id as ConditionalBatchWritableField | undefined) ??
          "translatedText",
      );
    }
  }, [fieldToAdd, unused]);
  const updateChange = (
    index: number,
    change: ConditionalBatchSetFieldChangeV2,
  ): void =>
    onChange({
      ...action,
      changes: action.changes.map((entry, entryIndex) =>
        entryIndex === index ? change : entry,
      ),
    });
  return (
    <>
      <div className={styles.setFieldList}>
        {action.changes.map((change, index) => (
          <div className={styles.setFieldRow} key={change.field}>
            <Field as="div" label="속성">
              <Select
                ariaLabel="바꿀 속성"
                searchable
                value={change.field}
                options={writableFields.map((field) => ({
                  value: field.id,
                  label: field.label,
                  group: field.categoryLabel,
                  searchText: `${field.label} ${field.id} ${field.categoryLabel}`,
                  disabled: action.changes.some(
                    (entry) =>
                      entry.field === field.id && entry.field !== change.field,
                  ),
                }))}
                onValueChange={(field) => {
                  const nextField = field as ConditionalBatchWritableField;
                  const changes = action.changes.map((entry, entryIndex) =>
                    entryIndex === index
                      ? createSetFieldChange(nextField)
                      : entry,
                  );
                  onChange({
                    ...action,
                    changes: appendSetFieldDependencies(changes, nextField),
                  });
                }}
              />
            </Field>
            <Field as="div" label="방법">
              <Select
                ariaLabel="속성 변경 방법"
                value={change.operation}
                options={[
                  { value: "set", label: "값 설정" },
                  { value: "clear", label: "초기화" },
                ]}
                onValueChange={(operation) =>
                  updateChange(
                    index,
                    operation === "clear"
                      ? { field: change.field, operation }
                      : createSetFieldChange(change.field),
                  )
                }
              />
            </Field>
            {change.operation === "set" ? (
              <SetFieldValueEditor
                change={change}
                onChange={(next) => updateChange(index, next)}
              />
            ) : (
              <span />
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label="속성 변경 삭제"
              disabled={action.changes.length <= 1}
              iconLeft={<IconTrash size={14} />}
              onClick={() =>
                onChange({
                  ...action,
                  changes: action.changes.filter(
                    (_entry, entryIndex) => entryIndex !== index,
                  ),
                })
              }
            />
          </div>
        ))}
      </div>
      {unused.length ? (
        <div className={styles.fieldPickerAll}>
          <Select
            ariaLabel="추가할 속성"
            searchable
            value={fieldToAdd}
            options={unused.map((field) => ({
              value: field.id,
              label: field.label,
              group: field.categoryLabel,
              searchText: `${field.label} ${field.id} ${field.categoryLabel}`,
            }))}
            onValueChange={(field) =>
              setFieldToAdd(field as ConditionalBatchWritableField)
            }
          />
          <Button
            size="sm"
            iconLeft={<IconPlus size={14} />}
            disabled={!unused.some((field) => field.id === fieldToAdd)}
            onClick={() => {
              if (!unused.some((field) => field.id === fieldToAdd)) return;
              const changes = [
                ...action.changes,
                createSetFieldChange(fieldToAdd),
              ];
              onChange({
                ...action,
                changes: appendSetFieldDependencies(changes, fieldToAdd),
              });
            }}
          >
            속성 추가
          </Button>
        </div>
      ) : null}
    </>
  );
}

// eslint-disable-next-line complexity -- the field registry's finite value kinds intentionally share one editor dispatch point
function SetFieldValueEditor({
  change,
  onChange,
}: {
  change: ConditionalBatchSetFieldChangeV2;
  onChange: (change: ConditionalBatchSetFieldChangeV2) => void;
}) {
  const definition = getConditionalBatchFieldDefinition(change.field);
  const enumOptions = conditionalBatchEnumOptions(change.field);
  if (change.field === "fontFamily") {
    return (
      <Field as="div" label="글꼴">
        <FontSelect
          ariaLabel="설정할 글꼴"
          value={String(change.value ?? "") || undefined}
          onChange={(fontFamily) =>
            onChange({ ...change, value: fontFamily ?? "" })
          }
        />
      </Field>
    );
  }
  if (definition.kind === "enum") {
    return (
      <Field as="div" label="값">
        <Select
          ariaLabel={`${CONDITIONAL_BATCH_FIELD_LABELS[change.field]} 값`}
          value={String(change.value ?? "")}
          options={enumOptions}
          onValueChange={(value) => onChange({ ...change, value })}
        />
      </Field>
    );
  }
  if (definition.kind === "boolean") {
    return (
      <CheckboxField
        checked={Boolean(change.value)}
        label="켜기"
        onCheckedChange={(value) => onChange({ ...change, value })}
      />
    );
  }
  if (definition.kind === "number") {
    const number = definition.number;
    return (
      <TextField
        type="number"
        min={number?.min}
        max={number?.max}
        step={number?.step ?? "any"}
        label="값"
        value={
          typeof change.value === "number"
            ? change.value
            : (number?.defaultValue ?? 0)
        }
        onChange={(event) =>
          onChange({ ...change, value: Number(event.target.value) })
        }
      />
    );
  }
  if (definition.kind === "color") {
    return (
      <ColorField
        label={`${CONDITIONAL_BATCH_FIELD_LABELS[change.field]} 값`}
        value={String(change.value ?? "#000000")}
        disabled={false}
        onChange={(value) => onChange({ ...change, value })}
      />
    );
  }
  return (
    <TextField
      label="값"
      value={String(change.value ?? "")}
      onChange={(event) => onChange({ ...change, value: event.target.value })}
    />
  );
}

function PresetActionEditor({
  action,
  presets,
  onChange,
}: {
  action: ConditionalBatchApplyStylePresetActionV2;
  presets: readonly BlockStylePreset[];
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  return (
    <>
      <Field as="div" label="스타일 프리셋">
        <Select
          ariaLabel="스타일 프리셋"
          value={action.presetId ?? ""}
          options={[
            ...(presets.some((preset) => preset.id === action.presetId)
              ? []
              : [
                  {
                    value: action.presetId ?? "",
                    label: `${action.presetName} (저장된 스냅샷)`,
                  },
                ]),
            ...presets.map((preset) => ({
              value: preset.id,
              label: preset.name,
            })),
          ]}
          onValueChange={(id) => {
            const preset = presets.find((entry) => entry.id === id);
            if (preset) onChange(createPresetAction(preset, action.id));
          }}
        />
      </Field>
      <div className={styles.snapshotMeta}>
        저장된 값 · {action.groupIds.join(", ")}
      </div>
    </>
  );
}

function StyleTextActionEditor({
  action,
  sampleText,
  onChange,
}: {
  action: ConditionalBatchStyleTextActionV2;
  sampleText?: string;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const updateStyle = <Key extends keyof TextStylePatch>(
    key: Key,
    value: TextStylePatch[Key] | undefined,
  ): void => {
    onChange({
      ...action,
      patch: updatePatch(action.patch, key, value),
    });
  };
  return (
    <>
      <div className={styles.actionOptions}>
        <Field as="div" label="서식 범위">
          <Select
            ariaLabel="서식 범위"
            value={action.scope}
            options={[
              { value: "allText", label: "문장 전체" },
              { value: "pattern", label: "찾은 글자만" },
            ]}
            onValueChange={(scope) =>
              onChange({
                ...action,
                scope: scope as ConditionalBatchStyleTextActionV2["scope"],
                matcher:
                  scope === "pattern"
                    ? (action.matcher ?? createConditionalLiteralMatcher(""))
                    : undefined,
              })
            }
          />
        </Field>
        <Field as="div" label="기존 부분 서식">
          <Select
            ariaLabel="부분 서식 적용 방식"
            value={action.styleMode}
            options={[
              { value: "overwrite", label: "지정 항목 덮어쓰기" },
              { value: "fillMissing", label: "빈 값만 채우기" },
              { value: "replace", label: "기존 서식 지우고 교체" },
            ]}
            onValueChange={(styleMode) =>
              onChange({
                ...action,
                styleMode:
                  styleMode as ConditionalBatchStyleTextActionV2["styleMode"],
              })
            }
          />
        </Field>
      </div>
      {action.scope === "pattern" && action.matcher ? (
        <ConditionalPatternBuilder
          matcher={action.matcher}
          sampleText={sampleText}
          onChangeMatcher={(matcher) => onChange({ ...action, matcher })}
        />
      ) : null}
      <ExistingStyleMatchEditor action={action} onChange={onChange} />
      <div className={styles.inlineStyleGrid}>
        <PatchBoolean
          label="굵게"
          value={action.patch.bold}
          onChange={(bold) => updateStyle("bold", bold)}
        />
        <PatchBoolean
          label="기울임"
          value={action.patch.italic}
          onChange={(italic) => updateStyle("italic", italic)}
        />
        <PatchBoolean
          label="밑줄"
          value={action.patch.underline}
          onChange={(underline) => updateStyle("underline", underline)}
        />
        <PatchBoolean
          label="취소선"
          value={action.patch.strikethrough}
          onChange={(strikethrough) =>
            updateStyle("strikethrough", strikethrough)
          }
        />
        <PatchBoolean
          label="강조점"
          value={action.patch.emphasisMark}
          onChange={(emphasisMark) => updateStyle("emphasisMark", emphasisMark)}
        />
        <PatchValue
          label="글자 크기"
          type="number"
          value={action.patch.sizePx}
          onChange={(sizePx) => updateStyle("sizePx", sizePx)}
        />
        <PatchFontValue
          value={action.patch.fontFamily}
          onChange={(fontFamily) => updateStyle("fontFamily", fontFamily)}
        />
        <PatchValue
          label="불투명도"
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={action.patch.opacity}
          onChange={(opacity) => updateStyle("opacity", opacity)}
        />
        <PatchValue
          label="장평"
          type="number"
          min={0.1}
          max={5}
          step={0.05}
          value={action.patch.widthScale}
          onChange={(widthScale) => updateStyle("widthScale", widthScale)}
        />
      </div>
      <details className={styles.inlineStyleAdvanced}>
        <summary>색상 · 외곽선 · 광선</summary>
        <div className={styles.inlineStyleGrid}>
          <PatchColorValue
            label="글자색"
            value={action.patch.color}
            onChange={(color) => updateStyle("color", color)}
          />
          <PatchColorValue
            label="글자 배경색"
            value={action.patch.backgroundColor}
            onChange={(backgroundColor) =>
              updateStyle("backgroundColor", backgroundColor)
            }
          />
          <PatchColorValue
            label="외곽선색"
            value={action.patch.outlineColor}
            onChange={(outlineColor) =>
              updateStyle("outlineColor", outlineColor)
            }
          />
          <PatchValue
            label="외곽선 두께"
            type="number"
            min={0}
            max={64}
            step={0.5}
            value={action.patch.outlineWidthPx}
            onChange={(outlineWidthPx) =>
              updateStyle("outlineWidthPx", outlineWidthPx)
            }
          />
          <PatchColorValue
            label="바깥 외곽선색"
            value={action.patch.outerOutlineColor}
            onChange={(outerOutlineColor) =>
              updateStyle("outerOutlineColor", outerOutlineColor)
            }
          />
          <PatchValue
            label="바깥 외곽선 두께"
            type="number"
            min={0}
            max={64}
            step={0.5}
            value={action.patch.outerOutlineWidthPx}
            onChange={(outerOutlineWidthPx) =>
              updateStyle("outerOutlineWidthPx", outerOutlineWidthPx)
            }
          />
          <PatchColorValue
            label="광선색"
            value={action.patch.glowColor}
            onChange={(glowColor) => updateStyle("glowColor", glowColor)}
          />
          <PatchValue
            label="광선 퍼짐"
            type="number"
            min={0}
            max={64}
            step={1}
            value={action.patch.glowBlurPx}
            onChange={(glowBlurPx) => updateStyle("glowBlurPx", glowBlurPx)}
          />
          <PatchValue
            label="광선 불투명도"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={action.patch.glowOpacity}
            onChange={(glowOpacity) => updateStyle("glowOpacity", glowOpacity)}
          />
        </div>
      </details>
      {action.scope === "pattern" ? (
        <div className={styles.actionToggles}>
          <CheckboxField
            checked={action.allOccurrences}
            label="모든 일치 항목"
            onCheckedChange={(allOccurrences) =>
              onChange({ ...action, allOccurrences })
            }
          />
        </div>
      ) : null}
    </>
  );
}

const TEXT_STYLE_FIELD_LABELS: Record<ConditionalBatchTextStyleField, string> =
  {
    bold: "굵게",
    italic: "기울임",
    underline: "밑줄",
    strikethrough: "취소선",
    emphasisMark: "강조점",
    fontFamily: "글꼴",
    sizePx: "크기",
    opacity: "불투명도",
    widthScale: "장평",
    color: "글자색",
    backgroundColor: "글자 배경색",
    outlineColor: "외곽선색",
    outlineWidthPx: "외곽선 두께",
    outerOutlineColor: "바깥 외곽선색",
    outerOutlineWidthPx: "바깥 외곽선 두께",
    glowColor: "광선색",
    glowBlurPx: "광선 퍼짐",
    glowOpacity: "광선 불투명도",
  };

function ExistingStyleMatchEditor({
  action,
  onChange,
}: {
  action: ConditionalBatchStyleTextActionV2;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const matchStyle = action.matchStyle;
  const usedFields = new Set(
    matchStyle?.conditions.map((condition) => condition.field) ?? [],
  );
  const availableFields = CONDITIONAL_BATCH_TEXT_STYLE_FIELDS.filter(
    (field) => !usedFields.has(field),
  );
  const updateMatch = (
    conditions: ConditionalBatchTextStyleMatchCondition[],
  ): void => {
    onChange({
      ...action,
      matchStyle: {
        logic: matchStyle?.logic ?? "all",
        conditions,
      },
    });
  };
  return (
    <div className={styles.existingStyleMatch}>
      <div className={styles.existingStyleMatchHeader}>
        <CheckboxField
          checked={Boolean(matchStyle)}
          label="기존 서식으로 범위 좁히기"
          onCheckedChange={(checked) =>
            onChange({
              ...action,
              matchStyle: checked
                ? {
                    logic: "all",
                    conditions: [createTextStyleMatchCondition("bold")],
                  }
                : undefined,
            })
          }
        />
        {matchStyle && matchStyle.conditions.length > 1 ? (
          <SegmentedControl
            ariaLabel="부분 서식 조건 조합"
            singleRow
            value={matchStyle.logic}
            options={[
              { id: "all", label: "모두" },
              { id: "any", label: "하나라도" },
            ]}
            onChange={(logic) =>
              onChange({
                ...action,
                matchStyle: { ...matchStyle, logic },
              })
            }
          />
        ) : null}
      </div>
      {matchStyle ? (
        <div className={styles.existingStyleConditions}>
          {matchStyle.conditions.map((condition, index) => (
            <TextStyleMatchConditionEditor
              key={condition.id}
              condition={condition}
              disabledFields={usedFields}
              onChange={(next) =>
                updateMatch(
                  matchStyle.conditions.map((entry, entryIndex) =>
                    entryIndex === index ? next : entry,
                  ),
                )
              }
              onDelete={() =>
                matchStyle.conditions.length === 1
                  ? onChange({ ...action, matchStyle: undefined })
                  : updateMatch(
                      matchStyle.conditions.filter(
                        (_entry, entryIndex) => entryIndex !== index,
                      ),
                    )
              }
            />
          ))}
          {availableFields.length ? (
            <Button
              size="sm"
              variant="ghost"
              iconLeft={<IconPlus size={14} />}
              onClick={() =>
                updateMatch([
                  ...matchStyle.conditions,
                  createTextStyleMatchCondition(availableFields[0] ?? "bold"),
                ])
              }
            >
              서식 조건 추가
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TextStyleMatchConditionEditor({
  condition,
  disabledFields,
  onChange,
  onDelete,
}: {
  condition: ConditionalBatchTextStyleMatchCondition;
  disabledFields: ReadonlySet<ConditionalBatchTextStyleField>;
  onChange: (condition: ConditionalBatchTextStyleMatchCondition) => void;
  onDelete: () => void;
}) {
  const operators = textStyleOperatorOptions(condition.field);
  return (
    <div className={styles.existingStyleConditionRow}>
      <Select
        ariaLabel="기존 부분 서식"
        value={condition.field}
        options={CONDITIONAL_BATCH_TEXT_STYLE_FIELDS.map((field) => ({
          value: field,
          label: TEXT_STYLE_FIELD_LABELS[field],
          disabled: field !== condition.field && disabledFields.has(field),
        }))}
        onValueChange={(field) =>
          onChange(
            createTextStyleMatchCondition(
              field as ConditionalBatchTextStyleField,
              condition.id,
            ),
          )
        }
      />
      <Select
        ariaLabel="부분 서식 비교 방식"
        value={condition.operator}
        options={operators}
        onValueChange={(operator) =>
          onChange({
            ...condition,
            operator: operator as ConditionalBatchTextStyleOperator,
            ...(operator === "between"
              ? { value2: Number(condition.value) }
              : { value2: undefined }),
          })
        }
      />
      <TextStyleMatchValueEditor condition={condition} onChange={onChange} />
      <IconButton label="부분 서식 조건 삭제" onClick={onDelete}>
        <IconTrash size={15} />
      </IconButton>
    </div>
  );
}

function TextStyleMatchValueEditor({
  condition,
  onChange,
}: {
  condition: ConditionalBatchTextStyleMatchCondition;
  onChange: (condition: ConditionalBatchTextStyleMatchCondition) => void;
}) {
  if (isTextStyleBooleanField(condition.field)) {
    return (
      <Select
        ariaLabel="부분 서식 값"
        value={condition.value === true ? "true" : "false"}
        options={[
          { value: "true", label: "켜짐" },
          { value: "false", label: "꺼짐" },
        ]}
        onValueChange={(value) =>
          onChange({ ...condition, value: value === "true" })
        }
      />
    );
  }
  if (condition.field === "fontFamily") {
    return (
      <FontSelect
        ariaLabel="비교할 부분 서식 글꼴"
        value={String(condition.value) || undefined}
        onChange={(fontFamily) =>
          onChange({ ...condition, value: fontFamily ?? "" })
        }
      />
    );
  }
  if (isTextStyleColorField(condition.field)) {
    return (
      <ColorField
        label="부분 서식 색상"
        value={String(condition.value) || "#000000"}
        disabled={false}
        onChange={(value) => onChange({ ...condition, value })}
      />
    );
  }
  const [minimum, maximum, step] = textStyleNumberRange(condition.field);
  return (
    <div className={styles.existingStyleNumberValue}>
      <input
        aria-label="부분 서식 비교 값"
        type="number"
        min={minimum}
        max={maximum}
        step={step}
        value={Number(condition.value)}
        onChange={(event) =>
          onChange({ ...condition, value: Number(event.target.value) })
        }
      />
      {condition.operator === "between" ? (
        <>
          <span>~</span>
          <input
            aria-label="부분 서식 범위 끝 값"
            type="number"
            min={minimum}
            max={maximum}
            step={step}
            value={condition.value2 ?? Number(condition.value)}
            onChange={(event) =>
              onChange({ ...condition, value2: Number(event.target.value) })
            }
          />
        </>
      ) : null}
    </div>
  );
}

function createTextStyleMatchCondition(
  field: ConditionalBatchTextStyleField,
  id = createConditionalBatchClientId("style-condition"),
): ConditionalBatchTextStyleMatchCondition {
  if (field === "fontFamily") {
    return { id, field, operator: "equals", value: "" };
  }
  if (isTextStyleColorField(field)) {
    return { id, field, operator: "equals", value: "#000000" };
  }
  if (field === "sizePx") {
    return { id, field, operator: "greaterThanOrEqual", value: 24 };
  }
  if (field === "opacity" || field === "glowOpacity") {
    return { id, field, operator: "lessThanOrEqual", value: 1 };
  }
  if (field === "widthScale") {
    return { id, field, operator: "greaterThanOrEqual", value: 1 };
  }
  if (
    field === "outlineWidthPx" ||
    field === "outerOutlineWidthPx" ||
    field === "glowBlurPx"
  ) {
    return { id, field, operator: "greaterThanOrEqual", value: 1 };
  }
  return { id, field, operator: "equals", value: true };
}

function textStyleOperatorOptions(field: ConditionalBatchTextStyleField) {
  if (field === "fontFamily" || isTextStyleColorField(field)) {
    return [
      { value: "equals", label: "같음" },
      { value: "notEquals", label: "다름" },
    ];
  }
  if (isTextStyleBooleanField(field)) {
    return [{ value: "equals", label: "상태" }];
  }
  return [
    { value: "equals", label: "같음" },
    { value: "notEquals", label: "다름" },
    { value: "greaterThan", label: "초과" },
    { value: "greaterThanOrEqual", label: "이상" },
    { value: "lessThan", label: "미만" },
    { value: "lessThanOrEqual", label: "이하" },
    { value: "between", label: "범위" },
  ];
}

function isTextStyleBooleanField(
  field: ConditionalBatchTextStyleField,
): boolean {
  return [
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "emphasisMark",
  ].includes(field);
}

function isTextStyleColorField(field: ConditionalBatchTextStyleField): boolean {
  return [
    "color",
    "backgroundColor",
    "outlineColor",
    "outerOutlineColor",
    "glowColor",
  ].includes(field);
}

function textStyleNumberRange(
  field: ConditionalBatchTextStyleField,
): readonly [number, number, number] {
  if (field === "opacity" || field === "glowOpacity") return [0, 1, 0.05];
  if (field === "widthScale") return [0.1, 5, 0.05];
  if (
    field === "outlineWidthPx" ||
    field === "outerOutlineWidthPx" ||
    field === "glowBlurPx"
  ) {
    return [0, 64, 0.5];
  }
  return [1, 512, 1];
}

function PatchFontValue({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (value: string | null | undefined) => void;
}) {
  const enabled = value !== undefined;
  return (
    <div className={styles.patchField}>
      <CheckboxField
        checked={enabled}
        label="글꼴"
        onCheckedChange={(checked) => onChange(checked ? "" : undefined)}
      />
      {enabled ? (
        <div className={styles.patchValue}>
          <FontSelect
            ariaLabel="부분 서식 글꼴"
            disabled={value === null}
            value={typeof value === "string" ? value || undefined : undefined}
            onChange={(fontFamily) => onChange(fontFamily ?? "")}
          />
          <CheckboxField
            checked={value === null}
            label="초기화"
            onCheckedChange={(checked) => onChange(checked ? null : "")}
          />
        </div>
      ) : null}
    </div>
  );
}

function PatchColorValue({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string | null | undefined) => void;
  value: string | null | undefined;
}) {
  const enabled = value !== undefined;
  return (
    <div className={styles.patchField}>
      <CheckboxField
        checked={enabled}
        label={label}
        onCheckedChange={(checked) => onChange(checked ? "#000000" : undefined)}
      />
      {enabled ? (
        <div className={styles.patchValue}>
          <ColorField
            label={label}
            disabled={value === null}
            value={typeof value === "string" ? value : "#000000"}
            onChange={onChange}
          />
          <CheckboxField
            checked={value === null}
            label="초기화"
            onCheckedChange={(checked) => onChange(checked ? null : "#000000")}
          />
        </div>
      ) : null}
    </div>
  );
}

function PatchBoolean({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null | undefined;
  onChange: (value: boolean | null | undefined) => void;
}) {
  const enabled = value !== undefined;
  return (
    <div className={styles.patchField}>
      <CheckboxField
        checked={enabled}
        label={label}
        onCheckedChange={(checked) => onChange(checked ? true : undefined)}
      />
      {enabled ? (
        <SegmentedControl
          ariaLabel={`${label} 값`}
          singleRow
          value={value === true ? "on" : value === false ? "off" : "clear"}
          options={[
            { id: "on", label: "켜기" },
            { id: "off", label: "끄기" },
            { id: "clear", label: "초기화" },
          ]}
          onChange={(next) =>
            onChange(next === "on" ? true : next === "off" ? false : null)
          }
        />
      ) : null}
    </div>
  );
}

function PatchValue<TValue extends string | number>({
  label,
  value,
  type = "text",
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: TValue | null | undefined;
  type?: "text" | "number";
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: TValue | null | undefined) => void;
}) {
  const enabled = value !== undefined;
  return (
    <div className={styles.patchField}>
      <CheckboxField
        checked={enabled}
        label={label}
        onCheckedChange={(checked) =>
          onChange(
            checked ? ((type === "number" ? 1 : "") as TValue) : undefined,
          )
        }
      />
      {enabled ? (
        <div className={styles.patchValue}>
          <input
            type={type}
            min={min}
            max={max}
            step={step ?? (type === "number" ? "any" : undefined)}
            disabled={value === null}
            value={value ?? ""}
            onChange={(event) =>
              onChange(
                type === "number"
                  ? (Number(event.target.value) as TValue)
                  : (event.target.value as TValue),
              )
            }
          />
          <CheckboxField
            checked={value === null}
            label="초기화"
            onCheckedChange={(checked) =>
              onChange(
                checked ? null : ((type === "number" ? 1 : "") as TValue),
              )
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function createActionActions(
  { draft, onChangeDraft }: ConditionalBatchActionsCardProps,
  setActiveId: (id: string | null) => void,
) {
  const commit = (actions: ConditionalBatchActionV2[]): void =>
    onChangeDraft({ ...draft, actions: normalizeActionOrder(actions) });
  const addAction = (
    type: "replaceText" | "setFields" | "setText" | "styleText",
  ): void => {
    const action =
      type === "setText"
        ? ({
            id: createConditionalBatchClientId("action"),
            enabled: true,
            type: "setFields",
            changes: [
              {
                field: "translatedText",
                operation: "set",
                value: "",
              },
            ],
          } satisfies ConditionalBatchSetFieldsActionV2)
        : createDefaultAction(type);
    commit([...draft.actions, action]);
    setActiveId(action.id);
  };
  const addPresetAction = (preset: BlockStylePreset): void => {
    const action = createPresetAction(preset);
    commit([...draft.actions, action]);
    setActiveId(action.id);
  };
  const updateAction = (id: string, next: ConditionalBatchActionV2): void =>
    commit(
      draft.actions.map((action) =>
        action.id === id ? { ...next, id } : action,
      ),
    );
  const removeAction = (id: string): void => {
    commit(draft.actions.filter((action) => action.id !== id));
    setActiveId(null);
  };
  const duplicateAction = (id: string): void => {
    if (draft.actions.length >= MAX_CONDITIONAL_BATCH_ACTIONS) return;
    const source = draft.actions.find((action) => action.id === id);
    if (!source) return;
    const duplicate = {
      ...structuredClone(source),
      id: createConditionalBatchClientId("action"),
    };
    const index = draft.actions.indexOf(source);
    const next = [...draft.actions];
    next.splice(index + 1, 0, duplicate);
    commit(next);
    setActiveId(duplicate.id);
  };
  const moveAction = (id: string, offset: -1 | 1): void => {
    const current = draft.actions.find((action) => action.id === id);
    if (!current) return;
    const stageActions = draft.actions.filter(
      (action) => actionStage(action) === actionStage(current),
    );
    const stageIndex = stageActions.findIndex((action) => action.id === id);
    const target = stageActions[stageIndex + offset];
    if (!target) return;
    dropAction(id, target.id);
  };
  const dropAction = (sourceId: string, targetId: string): void => {
    const source = draft.actions.find((action) => action.id === sourceId);
    const target = draft.actions.find((action) => action.id === targetId);
    if (!source || !target || actionStage(source) !== actionStage(target)) {
      return;
    }
    const next = draft.actions.filter((action) => action.id !== sourceId);
    const targetIndex = next.findIndex((action) => action.id === targetId);
    const sourceIndex = draft.actions.findIndex(
      (action) => action.id === sourceId,
    );
    const originalTargetIndex = draft.actions.findIndex(
      (action) => action.id === targetId,
    );
    const insertAt =
      sourceIndex < originalTargetIndex ? targetIndex + 1 : targetIndex;
    next.splice(insertAt, 0, source);
    commit(next);
  };
  return {
    addAction,
    addPresetAction,
    dropAction,
    duplicateAction,
    moveAction,
    removeAction,
    updateAction,
  };
}

function normalizeActionOrder(
  actions: readonly ConditionalBatchActionV2[],
): ConditionalBatchActionV2[] {
  return [1, 2, 3].flatMap((stage) =>
    actions.filter((action) => actionStage(action) === stage),
  );
}

function createPresetAction(
  preset: BlockStylePreset,
  id = createConditionalBatchClientId("action"),
): ConditionalBatchApplyStylePresetActionV2 {
  return {
    id,
    enabled: true,
    type: "applyStylePreset",
    presetId: preset.id,
    presetName: preset.name,
    groupIds: [...preset.groupIds],
    format: structuredClone(preset.format),
  };
}

function createSetFieldChange(
  field: ConditionalBatchWritableField,
): ConditionalBatchSetFieldChangeV2 {
  const definition = getConditionalBatchFieldDefinition(field);
  if (definition.kind === "boolean") {
    return { field, operation: "set", value: true };
  }
  if (definition.kind === "number") {
    return {
      field,
      operation: "set",
      value: definition.number?.defaultValue ?? 0,
    };
  }
  if (definition.kind === "color") {
    return {
      field,
      operation: "set",
      value: DEFAULT_SET_FIELD_COLORS[field] ?? "#000000",
    };
  }
  if (definition.kind === "enum") {
    return {
      field,
      operation: "set",
      value: conditionalBatchEnumOptions(field)[0]?.value ?? "",
    };
  }
  return { field, operation: "set", value: "" };
}

/**
 * A color or numeric component on its own can be valid persisted data while
 * its visual effect remains disabled. Rules created through the card editor
 * make those prerequisites explicit so a newly added property is visible in
 * the preview immediately. Imported YAML keeps its exact semantics.
 */
function appendSetFieldDependencies(
  changes: readonly ConditionalBatchSetFieldChangeV2[],
  field: ConditionalBatchWritableField,
): ConditionalBatchSetFieldChangeV2[] {
  const next = [...changes];
  const dependency = SET_FIELD_DEPENDENCIES[field];
  if (dependency && !next.some((change) => change.field === dependency.field)) {
    next.push(dependency);
  }
  return next;
}

const DEFAULT_SET_FIELD_COLORS: Partial<
  Record<ConditionalBatchWritableField, string>
> = {
  textColor: "#111111",
  outlineColor: "#ffffff",
  outerOutlineColor: "#111111",
  textBackgroundColor: "#ffffff",
  textEffectColor: "#000000",
  textGlowColor: "#ffffff",
};

const SET_FIELD_DEPENDENCIES: Partial<
  Record<ConditionalBatchWritableField, ConditionalBatchSetFieldChangeV2>
> = {
  textBackgroundColor: {
    field: "textBackgroundEnabled",
    operation: "set",
    value: true,
  },
  outerOutlineColor: {
    field: "outerOutlineWidthPx",
    operation: "set",
    value: 1.5,
  },
  textEffectColor: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textEffectOffsetX: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textEffectOffsetY: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textEffectBlur: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textEffectOpacity: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textGlowColor: {
    field: "textGlowEnabled",
    operation: "set",
    value: true,
  },
  textGlowBlur: {
    field: "textGlowEnabled",
    operation: "set",
    value: true,
  },
  textGlowOpacity: {
    field: "textGlowEnabled",
    operation: "set",
    value: true,
  },
};

function updatePatch<T extends object, K extends keyof T>(
  patch: T,
  key: K,
  value: T[K] | undefined,
): T {
  const next = { ...patch };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function readActionSample(
  action: ConditionalBatchActionV2,
  result: ConditionalBatchPreviewResult | null,
): string | undefined {
  if (!result) return undefined;
  if (action.type === "replaceText" && action.target === "sourceText") {
    return result.beforeBlock.sourceText;
  }
  if (action.type === "replaceText" || action.type === "styleText") {
    return stripRichTextMarkup(result.beforeBlock.translatedText);
  }
  return undefined;
}
