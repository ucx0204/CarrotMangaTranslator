/* eslint-disable max-lines, max-lines-per-function -- rule CRUD, recipes, YAML, and sequence composition share one progressive-disclosure panel */
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowBackUp,
  IconCopy,
  IconChevronDown,
  IconChevronRight,
  IconDeviceFloppy,
  IconEdit,
  IconFileExport,
  IconFileImport,
  IconFilePlus,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";
import React from "react";
import type { BlockStylePreset } from "../../../shared/blockStylePresets";
import type {
  ConditionalBatchPreviewResult,
  ConditionalBatchRecipeId,
  ConditionalBatchSchemeDraftV2,
  ConditionalBatchSchemeV2,
  ConditionalBatchSequenceV2,
  ConditionalBatchSequencePreview,
} from "../../../shared/conditionalBatchRules";
import { ConfirmModal } from "./ConfirmModal";
import { ConditionalBatchActionCard } from "./ConditionalBatchActionCard";
import { ConditionalBatchConditionsCard } from "./ConditionalBatchConditionsCard";
import { Button, CheckboxField, Select } from "./ConditionalBatchControls";
import type { ConditionalBatchApplyNotice } from "./useConditionalBatchSchemeController";
import type { ConditionalBatchTemporaryScheme } from "./useConditionalBatchSchemeController";
import { Field, TextField } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { InlineMessage } from "./ui/InlineMessage";
import { FavoriteToggleButton } from "./ui/FavoriteToggleButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { usePopupController } from "./ui/usePopupController";
import styles from "./ConditionalBatchEditor.module.css";

type ConditionalBatchScopeKind = "selection" | "page" | "chapter";

export type ConditionalBatchRulePanelProps = {
  activeSequence: ConditionalBatchSequenceV2 | null;
  applyNotice: ConditionalBatchApplyNotice;
  autosaveState: "idle" | "waiting" | "saving" | "saved" | "error";
  blockStylePresets: readonly BlockStylePreset[];
  canDeleteScheme: boolean;
  currentResult: ConditionalBatchPreviewResult | null;
  draft: ConditionalBatchSchemeDraftV2;
  favoriteSchemeIds: readonly string[];
  recipePickerCanClose: boolean;
  recipePickerOpen: boolean;
  savedSchemes: readonly ConditionalBatchSchemeV2[];
  scopeKind: ConditionalBatchScopeKind;
  selectedBlockCount: number;
  selectedSchemeId: string;
  sequences: readonly ConditionalBatchSequenceV2[];
  sequencePreview: ConditionalBatchSequencePreview | null;
  storageBusy: boolean;
  storageError: string | null;
  temporarySchemes: readonly ConditionalBatchTemporaryScheme[];
  validationMessage: string | null;
  yamlError: string | null;
  yamlOpen: boolean;
  yamlText: string;
  onChangeDraft: (draft: ConditionalBatchSchemeDraftV2) => void;
  onChangeScope: (scope: ConditionalBatchScopeKind) => void;
  onChooseRecipe: (
    recipe: ConditionalBatchRecipeId,
    preset?: BlockStylePreset,
  ) => void;
  onCloseRecipePicker: () => void;
  onDeleteScheme: () => void;
  onDeleteSequence: (id: string) => void;
  onDuplicateScheme: () => void;
  onExportYaml: (all: boolean) => void;
  onImportYaml: (policy?: "duplicate" | "overwrite") => void;
  onExitSequence: () => void;
  onNewScheme: () => void;
  onOpenYaml: () => void;
  onOpenYamlFile: () => void;
  onReflectYaml: () => void;
  onPreviewSequence: (id: string) => void;
  onSaveScheme: () => void;
  onSaveSequence: (sequence: ConditionalBatchSequenceV2) => void;
  onSelectScheme: (id: string) => void;
  onSetYamlOpen: (open: boolean) => void;
  onSetYamlText: (text: string) => void;
  onToggleSchemeFavorite: (id: string) => void;
};

export type ConditionalBatchFooterProps = {
  applyNotice: ConditionalBatchApplyNotice;
  busy: boolean;
  canUndo: boolean;
  conflictCount: number;
  excludedCount: number;
  includedCount: number;
  inspectionOnly: boolean;
  sequenceName: string | null;
  undoLabel: string | null;
  validationMessage: string | null;
  onApply: () => void;
  onUndo: () => void;
};

export function ConditionalBatchRulePanel(
  props: ConditionalBatchRulePanelProps,
): React.JSX.Element {
  const [conditionsExpanded, setConditionsExpanded] = React.useState(true);
  const [actionsExpanded, setActionsExpanded] = React.useState(true);
  const [sequenceExpanded, setSequenceExpanded] = React.useState(true);
  const [advancedExpanded, setAdvancedExpanded] = React.useState(true);
  return (
    <aside className={styles.rulePanel} aria-label="일괄 편집 규칙">
      {props.activeSequence ? null : <SchemeManager {...props} />}
      <div className={styles.rulePanelScroll}>
        {props.activeSequence ? (
          <SequenceRunCard {...props} />
        ) : props.recipePickerOpen ? (
          <RecipePicker {...props} />
        ) : (
          <>
            <ScopeCard {...props} />
            <ConditionalBatchConditionsCard
              currentResult={props.currentResult}
              draft={props.draft}
              expanded={conditionsExpanded}
              ruleId={props.selectedSchemeId}
              onChangeDraft={props.onChangeDraft}
              onToggle={() => setConditionsExpanded((current) => !current)}
            />
            <ConditionalBatchActionCard
              blockStylePresets={props.blockStylePresets}
              currentResult={props.currentResult}
              draft={props.draft}
              expanded={actionsExpanded}
              onChangeDraft={props.onChangeDraft}
              onToggle={() => setActionsExpanded((current) => !current)}
            />
            <SequenceManager
              {...props}
              expanded={sequenceExpanded}
              onToggle={() => setSequenceExpanded((current) => !current)}
            />
            <AdvancedTools
              {...props}
              expanded={advancedExpanded}
              onToggle={() => setAdvancedExpanded((current) => !current)}
            />
            <RuleNotices {...props} />
          </>
        )}
      </div>
    </aside>
  );
}

function SequenceRunCard(props: ConditionalBatchRulePanelProps) {
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

function SchemeManager(props: ConditionalBatchRulePanelProps) {
  const [editorOpen, setEditorOpen] = React.useState(false);
  const { contentRef, rootRef, toggle, triggerRef } = usePopupController({
    disabled: props.storageBusy,
    initialFocus: "input:not(:disabled)",
    open: editorOpen,
    onOpenChange: setEditorOpen,
  });
  const selectedStored = props.savedSchemes.some(
    (scheme) => scheme.id === props.selectedSchemeId,
  );
  const favoriteIds = new Set(props.favoriteSchemeIds);
  const orderedSavedSchemes = [...props.savedSchemes].sort(
    (left, right) =>
      Number(favoriteIds.has(right.id)) - Number(favoriteIds.has(left.id)),
  );
  const options = [
    ...props.temporarySchemes.map((scheme) => ({
      value: scheme.id,
      label: `${scheme.name}${scheme.dirty ? " •" : ""}`,
      group: "이번 모달의 임시 규칙",
    })),
    ...orderedSavedSchemes.map((scheme) => ({
      value: scheme.id,
      label: scheme.name,
      description: scheme.description || undefined,
      group: favoriteIds.has(scheme.id) ? "즐겨찾기" : "저장된 규칙",
      actions: (
        <FavoriteToggleButton
          favorite={favoriteIds.has(scheme.id)}
          disabled={props.storageBusy}
          label={
            favoriteIds.has(scheme.id)
              ? `${scheme.name} 빠른 규칙에서 제거`
              : `${scheme.name} 빠른 규칙에 추가`
          }
          onToggle={() => props.onToggleSchemeFavorite(scheme.id)}
        />
      ),
    })),
  ];
  return (
    <>
      <section className={styles.schemeBar}>
        <Select
          ariaLabel="현재 규칙"
          searchable
          value={props.selectedSchemeId}
          options={options}
          disabled={props.storageBusy}
          onValueChange={props.onSelectScheme}
        />
        <Button
          size="sm"
          variant="ghost"
          iconLeft={<IconFilePlus size={15} />}
          disabled={props.storageBusy}
          onClick={props.onNewScheme}
        >
          새 규칙
        </Button>
        {!selectedStored ? (
          <Button
            size="sm"
            iconLeft={<IconDeviceFloppy size={16} />}
            disabled={props.storageBusy || Boolean(props.validationMessage)}
            onClick={props.onSaveScheme}
          >
            저장
          </Button>
        ) : null}
        <div className={styles.schemeMenu} ref={rootRef}>
          <IconButton
            ref={triggerRef}
            size="sm"
            label="규칙 편집"
            aria-expanded={editorOpen}
            aria-haspopup="dialog"
            disabled={props.storageBusy}
            onClick={toggle}
          >
            <IconEdit size={16} aria-hidden="true" />
          </IconButton>
          {editorOpen ? (
            <div
              ref={contentRef}
              className={styles.schemeMenuPopover}
              role="dialog"
              aria-label="규칙 편집"
            >
              <TextField
                label="규칙 이름"
                value={props.draft.name}
                maxLength={80}
                onChange={(event) =>
                  props.onChangeDraft({
                    ...props.draft,
                    name: event.target.value,
                  })
                }
              />
              <Field label="설명">
                <textarea
                  rows={2}
                  value={props.draft.description}
                  maxLength={500}
                  onChange={(event) =>
                    props.onChangeDraft({
                      ...props.draft,
                      description: event.target.value,
                    })
                  }
                />
              </Field>
              <div className={styles.schemeToolbar}>
                {selectedStored ? (
                  <Button
                    size="sm"
                    iconLeft={<IconDeviceFloppy size={15} />}
                    disabled={
                      props.storageBusy || Boolean(props.validationMessage)
                    }
                    onClick={props.onSaveScheme}
                  >
                    지금 저장
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="규칙 복제"
                  iconLeft={<IconCopy size={15} />}
                  disabled={props.storageBusy}
                  onClick={props.onDuplicateScheme}
                >
                  복제
                </Button>
              </div>
              {selectedStored ? (
                <span
                  className={styles.autosaveState}
                  data-state={props.autosaveState}
                >
                  {autosaveLabel(props.autosaveState, true)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <SchemeDeleteControl
          name={props.draft.name}
          stored={selectedStored}
          disabled={props.storageBusy || !props.canDeleteScheme}
          onDelete={props.onDeleteScheme}
        />
      </section>
    </>
  );
}

function SchemeDeleteControl({
  disabled,
  name,
  stored,
  onDelete,
}: {
  disabled: boolean;
  name: string;
  stored: boolean;
  onDelete: () => void;
}): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const action = stored ? "삭제" : "제거";
  const label = stored ? "저장된 규칙 삭제" : "임시 규칙 제거";
  return (
    <>
      <IconButton
        size="sm"
        variant="danger"
        label={label}
        disabled={disabled}
        onClick={() => setConfirmOpen(true)}
      >
        <IconTrash size={16} aria-hidden="true" />
      </IconButton>
      {confirmOpen ? (
        <ConfirmModal
          title={stored ? "규칙 삭제" : "임시 규칙 제거"}
          message={`“${name}” 규칙을 ${action}할까요?`}
          confirmLabel={action}
          confirmVariant="danger"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            onDelete();
          }}
        />
      ) : null}
    </>
  );
}

function RecipePicker(props: ConditionalBatchRulePanelProps) {
  const favoriteIds = new Set(props.favoriteSchemeIds);
  const quickSchemes = props.savedSchemes.filter((scheme) =>
    favoriteIds.has(scheme.id),
  );
  return (
    <section className={styles.recipePanel}>
      <header>
        <strong>새 규칙</strong>
        <div className={styles.recipeHeaderActions}>
          {props.recipePickerCanClose ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={props.onCloseRecipePicker}
            >
              닫기
            </Button>
          ) : null}
        </div>
      </header>
      <div className={styles.recipeGrid}>
        {quickSchemes.map((scheme) => (
          <Button
            key={scheme.id}
            size="sm"
            fullWidth
            onClick={() => {
              props.onCloseRecipePicker();
              props.onSelectScheme(scheme.id);
            }}
          >
            {scheme.name}
          </Button>
        ))}
        <Button
          className={styles.directRecipe}
          fullWidth
          variant="primary"
          onClick={() => props.onChooseRecipe("blank")}
        >
          직접 규칙 생성
        </Button>
      </div>
    </section>
  );
}

function ScopeCard(props: ConditionalBatchRulePanelProps) {
  return (
    <section className={styles.scopeCard}>
      <strong>범위</strong>
      <SegmentedControl
        ariaLabel="적용 범위"
        singleRow
        options={[
          {
            id: "selection",
            label: "선택",
            badge: props.selectedBlockCount || undefined,
            disabled: props.selectedBlockCount === 0,
          },
          { id: "page", label: "페이지" },
          { id: "chapter", label: "화" },
        ]}
        value={props.scopeKind}
        onChange={props.onChangeScope}
      />
    </section>
  );
}

function RuleNotices(props: ConditionalBatchRulePanelProps) {
  return (
    <>
      {props.validationMessage ? (
        <InlineMessage
          variant="warning"
          title="규칙 오류"
          detail={props.validationMessage}
        />
      ) : null}
      {props.storageError ? (
        <InlineMessage
          variant="danger"
          title="저장 오류"
          detail={props.storageError}
        />
      ) : null}
      {props.applyNotice ? (
        <InlineMessage
          variant={props.applyNotice.kind}
          title={props.applyNotice.message}
        />
      ) : null}
    </>
  );
}

function AdvancedTools(
  props: ConditionalBatchRulePanelProps & {
    expanded: boolean;
    onToggle: () => void;
  },
) {
  return (
    <section className={styles.advancedTools} data-expanded={props.expanded}>
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
          <strong>고급</strong>
        </span>
      </button>
      {props.expanded ? (
        <div className={styles.advancedBody}>
          <div className={styles.advancedButtons}>
            <Button
              size="sm"
              iconLeft={<IconFileExport size={15} />}
              onClick={() => props.onExportYaml(false)}
            >
              규칙 내보내기
            </Button>
            <Button
              size="sm"
              iconLeft={<IconFileExport size={15} />}
              onClick={() => props.onExportYaml(true)}
            >
              전체 내보내기
            </Button>
            <Button size="sm" onClick={props.onOpenYaml}>
              직접 편집
            </Button>
            <Button
              size="sm"
              iconLeft={<IconFileImport size={15} />}
              onClick={props.onOpenYamlFile}
            >
              가져오기
            </Button>
          </div>
          {props.yamlOpen ? (
            <div className={styles.yamlEditor}>
              <textarea
                aria-label="일괄 편집 YAML"
                spellCheck={false}
                value={props.yamlText}
                onChange={(event) => props.onSetYamlText(event.target.value)}
              />
              {props.yamlError ? (
                <InlineMessage
                  variant="danger"
                  title="YAML 오류"
                  detail={props.yamlError}
                />
              ) : null}
              <div className={styles.yamlActions}>
                <Button size="sm" onClick={props.onReflectYaml}>
                  카드에 반영
                </Button>
                <Button
                  size="sm"
                  iconLeft={<IconFileImport size={15} />}
                  onClick={() => props.onImportYaml("duplicate")}
                >
                  새 규칙으로 가져오기
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => props.onImportYaml("overwrite")}
                >
                  같은 ID 덮어쓰기
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onSetYamlOpen(false)}
                >
                  닫기
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SequenceManager(
  props: ConditionalBatchRulePanelProps & {
    expanded: boolean;
    onToggle: () => void;
  },
) {
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("연속 실행");
  const [description, setDescription] = React.useState("");
  const [steps, setSteps] = React.useState<ConditionalBatchSequenceV2["steps"]>(
    [],
  );
  const [schemeToAdd, setSchemeToAdd] = React.useState(
    props.savedSchemes[0]?.id ?? "",
  );
  React.useEffect(() => {
    if (!props.savedSchemes.some((scheme) => scheme.id === schemeToAdd)) {
      setSchemeToAdd(props.savedSchemes[0]?.id ?? "");
    }
  }, [props.savedSchemes, schemeToAdd]);
  const reset = (): void => {
    setFormOpen(false);
    setEditingId(null);
    setName("연속 실행");
    setDescription("");
    setSteps([]);
  };
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
        id: duplicate ? createSequenceItemId("step") : step.id,
      })),
    );
  };
  const startNew = (): void => {
    setEditingId(null);
    setName("연속 실행");
    setDescription("");
    setSteps([]);
    setFormOpen(true);
  };
  const save = (): void => {
    if (
      !name.trim() ||
      steps.length === 0 ||
      !steps.some((step) => step.enabled)
    ) {
      return;
    }
    props.onSaveSequence({
      id: editingId ?? createSequenceItemId("sequence"),
      name: name.trim(),
      description: description.trim(),
      steps,
    });
    reset();
  };
  return (
    <section className={styles.sequenceManager} data-expanded={props.expanded}>
      <header className={styles.sequenceHeader}>
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
            <strong>연속 실행</strong>
          </span>
        </button>
        {props.expanded ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.savedSchemes.length === 0}
            onClick={startNew}
          >
            새 연속 실행
          </Button>
        ) : null}
      </header>
      {props.expanded ? (
        <>
          {props.sequences.map((sequence) => (
            <div className={styles.sequenceRow} key={sequence.id}>
              <span>
                <strong>{sequence.name}</strong>
                <small>{sequence.steps.length}단계</small>
              </span>
              <Button
                size="sm"
                onClick={() => props.onPreviewSequence(sequence.id)}
              >
                미리보기
              </Button>
              <IconButton
                size="sm"
                label={`${sequence.name} 편집`}
                onClick={() => edit(sequence)}
              >
                <IconEdit size={14} />
              </IconButton>
              <IconButton
                size="sm"
                label={`${sequence.name} 복제`}
                onClick={() => edit(sequence, true)}
              >
                <IconCopy size={14} />
              </IconButton>
              <IconButton
                size="sm"
                variant="danger"
                label={`${sequence.name} 삭제`}
                onClick={() => props.onDeleteSequence(sequence.id)}
              >
                <IconTrash size={14} />
              </IconButton>
            </div>
          ))}
          {formOpen ? (
            <div className={styles.sequenceForm}>
              <TextField
                label="연속 실행 이름"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
              <Field label="설명">
                <textarea
                  rows={2}
                  maxLength={500}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <div className={styles.sequenceSteps}>
                {steps.map((step, index) => (
                  <div className={styles.sequenceStepRow} key={step.id}>
                    <CheckboxField
                      checked={step.enabled}
                      ariaLabel={`${index + 1}번 연속 실행 단계 활성화`}
                      onCheckedChange={(enabled) =>
                        setSteps((current) =>
                          current.map((entry) =>
                            entry.id === step.id
                              ? { ...entry, enabled }
                              : entry,
                          ),
                        )
                      }
                    />
                    <span>{index + 1}</span>
                    <Select
                      ariaLabel={`${index + 1}번 연속 실행 규칙`}
                      value={step.schemeId}
                      options={props.savedSchemes.map((scheme) => ({
                        value: scheme.id,
                        label: scheme.name,
                      }))}
                      onValueChange={(schemeId) =>
                        setSteps((current) =>
                          current.map((entry) =>
                            entry.id === step.id
                              ? { ...entry, schemeId }
                              : entry,
                          ),
                        )
                      }
                    />
                    <div className={styles.sequenceStepActions}>
                      <IconButton
                        size="sm"
                        label="연속 실행 단계 위로 이동"
                        disabled={index === 0}
                        onClick={() =>
                          setSteps((current) =>
                            moveItem(current, index, index - 1),
                          )
                        }
                      >
                        <IconArrowUp size={14} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label="연속 실행 단계 아래로 이동"
                        disabled={index === steps.length - 1}
                        onClick={() =>
                          setSteps((current) =>
                            moveItem(current, index, index + 1),
                          )
                        }
                      >
                        <IconArrowDown size={14} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label="연속 실행 단계 복제"
                        disabled={steps.length >= 32}
                        onClick={() =>
                          setSteps((current) => {
                            const next = [...current];
                            next.splice(index + 1, 0, {
                              ...step,
                              id: createSequenceItemId("step"),
                            });
                            return next;
                          })
                        }
                      >
                        <IconCopy size={14} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        variant="danger"
                        label="연속 실행 단계 삭제"
                        onClick={() =>
                          setSteps((current) =>
                            current.filter((entry) => entry.id !== step.id),
                          )
                        }
                      >
                        <IconTrash size={14} />
                      </IconButton>
                    </div>
                  </div>
                ))}
              </div>
              {props.savedSchemes.length ? (
                <div className={styles.fieldPickerAll}>
                  <Select
                    ariaLabel="연속 실행에 추가할 규칙"
                    value={schemeToAdd}
                    options={props.savedSchemes.map((scheme) => ({
                      value: scheme.id,
                      label: scheme.name,
                    }))}
                    onValueChange={setSchemeToAdd}
                  />
                  <Button
                    size="sm"
                    disabled={!schemeToAdd || steps.length >= 32}
                    onClick={() =>
                      schemeToAdd &&
                      setSteps((current) => [
                        ...current,
                        {
                          id: createSequenceItemId("step"),
                          schemeId: schemeToAdd,
                          enabled: true,
                        },
                      ])
                    }
                  >
                    단계 추가
                  </Button>
                </div>
              ) : null}
              <div className={styles.sequenceFormActions}>
                <Button size="sm" variant="ghost" onClick={reset}>
                  취소
                </Button>
                <Button
                  size="sm"
                  disabled={
                    !name.trim() ||
                    steps.length === 0 ||
                    !steps.some((step) => step.enabled)
                  }
                  onClick={save}
                >
                  {editingId ? "업데이트" : "저장"}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function createSequenceItemId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

export function ConditionalBatchFooter(
  props: ConditionalBatchFooterProps,
): React.JSX.Element {
  return (
    <footer className={styles.applyFooter}>
      <div className={styles.applyActions}>
        {props.canUndo ? (
          <Button
            size="sm"
            iconLeft={<IconArrowBackUp size={17} />}
            disabled={props.busy}
            title={props.undoLabel ?? undefined}
            onClick={props.onUndo}
          >
            실행 취소
          </Button>
        ) : null}
        {props.inspectionOnly ? null : (
          <Button
            variant="primary"
            iconLeft={<IconWand size={18} />}
            disabled={
              props.busy ||
              Boolean(props.validationMessage) ||
              props.includedCount === 0
            }
            onClick={props.onApply}
          >
            {props.sequenceName ? "연속 실행" : "적용"}
          </Button>
        )}
      </div>
    </footer>
  );
}

function autosaveLabel(
  state: ConditionalBatchRulePanelProps["autosaveState"],
  stored: boolean,
): string {
  if (!stored) return "아직 저장되지 않음";
  if (state === "waiting") return "저장 대기";
  if (state === "saving") return "저장 중";
  if (state === "saved") return "자동 저장됨";
  if (state === "error") return "자동 저장 실패";
  return "저장된 규칙";
}
