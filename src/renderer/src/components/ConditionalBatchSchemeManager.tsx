import {
  IconCopy,
  IconDeviceFloppy,
  IconEdit,
  IconFilePlus,
  IconTrash,
} from "@tabler/icons-react";
import React from "react";
import type { ConditionalBatchRulePanelProps } from "./conditionalBatchRulePanelTypes";
import { ConfirmModal } from "./ConfirmModal";
import { Button, Select } from "./ConditionalBatchControls";
import { FavoriteToggleButton } from "./ui/FavoriteToggleButton";
import { TextareaField, TextField } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { usePopupController } from "./ui/usePopupController";
import styles from "./ConditionalBatchEditor.module.css";

type ConditionalBatchSchemeManagerProps = Pick<
  ConditionalBatchRulePanelProps,
  | "autosaveState"
  | "canDeleteScheme"
  | "draft"
  | "favoriteSchemeIds"
  | "onChangeDraft"
  | "onDeleteScheme"
  | "onDuplicateScheme"
  | "onNewScheme"
  | "onSaveScheme"
  | "onSelectScheme"
  | "onToggleSchemeFavorite"
  | "savedSchemes"
  | "selectedSchemeId"
  | "storageBusy"
  | "temporarySchemes"
  | "validationMessage"
>;

export function ConditionalBatchSchemeManager(
  props: ConditionalBatchSchemeManagerProps,
): React.JSX.Element {
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
      {!selectedStored ? <SaveSchemeButton {...props} /> : null}
      <SchemeEditorMenu {...props} selectedStored={selectedStored} />
      <SchemeDeleteControl
        name={props.draft.name}
        stored={selectedStored}
        disabled={props.storageBusy || !props.canDeleteScheme}
        onDelete={props.onDeleteScheme}
      />
    </section>
  );
}

function SaveSchemeButton(
  props: Pick<
    ConditionalBatchSchemeManagerProps,
    "onSaveScheme" | "storageBusy" | "validationMessage"
  >,
): React.JSX.Element {
  return (
    <Button
      size="sm"
      iconLeft={<IconDeviceFloppy size={16} />}
      disabled={props.storageBusy || Boolean(props.validationMessage)}
      onClick={props.onSaveScheme}
    >
      저장
    </Button>
  );
}

function SchemeEditorMenu(
  props: ConditionalBatchSchemeManagerProps & { selectedStored: boolean },
): React.JSX.Element {
  const [editorOpen, setEditorOpen] = React.useState(false);
  const { contentRef, rootRef, toggle, triggerRef } = usePopupController({
    disabled: props.storageBusy,
    initialFocus: "input:not(:disabled)",
    open: editorOpen,
    onOpenChange: setEditorOpen,
  });
  return (
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
          <SchemeEditorFields {...props} />
        </div>
      ) : null}
    </div>
  );
}

function SchemeEditorFields(
  props: ConditionalBatchSchemeManagerProps & { selectedStored: boolean },
): React.JSX.Element {
  return (
    <>
      <TextField
        label="규칙 이름"
        value={props.draft.name}
        maxLength={80}
        onChange={(event) =>
          props.onChangeDraft({ ...props.draft, name: event.target.value })
        }
      />
      <TextareaField
        label="설명"
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
      <div className={styles.schemeToolbar}>
        {props.selectedStored ? <SaveSchemeButton {...props} /> : null}
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
      {props.selectedStored ? (
        <span className={styles.autosaveState} data-state={props.autosaveState}>
          {autosaveLabel(props.autosaveState)}
        </span>
      ) : null}
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

function autosaveLabel(
  state: ConditionalBatchSchemeManagerProps["autosaveState"],
): string {
  if (state === "waiting") return "저장 대기";
  if (state === "saving") return "저장 중";
  if (state === "saved") return "자동 저장됨";
  if (state === "error") return "자동 저장 실패";
  return "저장된 규칙";
}
