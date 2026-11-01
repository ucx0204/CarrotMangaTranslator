import { useTranslation } from "react-i18next";
import { appI18n } from "../appI18n";
import {
  IconCopy,
  IconDeviceFloppy,
  IconEdit,
  IconFilePlus,
  IconTrash,
} from "@tabler/icons-react";
import React from "react";
import styles from "./ConditionalBatchEditor.module.css";
import type { ConditionalBatchRulePanelProps } from "./conditionalBatchRulePanelTypes";
import { ConfirmModal } from "./ConfirmModal";
import { Button } from "./ui/Button";
import { FavoriteToggleButton } from "./ui/FavoriteToggleButton";
import { TextareaField, TextField } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { Select } from "./ui/Select";
import { usePopupController } from "./ui/usePopupController";

const t = appI18n.getFixedT(null, "components");

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
  useTranslation();
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
      group: t("batchEditorCopy.temporaryRulesInThisDialog"),
    })),
    ...orderedSavedSchemes.map((scheme) => ({
      value: scheme.id,
      label: scheme.name,
      description: scheme.description || undefined,
      group: favoriteIds.has(scheme.id)
        ? t("fontManager.favorites")
        : t("batchEditorCopy.savedRules"),
      actions: (
        <FavoriteToggleButton
          favorite={favoriteIds.has(scheme.id)}
          disabled={props.storageBusy}
          label={
            favoriteIds.has(scheme.id)
              ? t("batchEditorMessages.removeFromQuickRules", {
                  p0: scheme.name,
                })
              : t("batchEditorMessages.addToQuickRules", {
                  p0: scheme.name,
                })
          }
          onToggle={() => props.onToggleSchemeFavorite(scheme.id)}
        />
      ),
    })),
  ];
  return (
    <section className={styles.schemeBar}>
      <Select
        ariaLabel={t("batchEditorCopy.currentRule")}
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
        {t("conditionalBatch.scheme.new")}
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
  useTranslation();
  return (
    <Button
      size="sm"
      iconLeft={<IconDeviceFloppy size={16} />}
      disabled={props.storageBusy || Boolean(props.validationMessage)}
      onClick={props.onSaveScheme}
    >
      {t("common.save")}
    </Button>
  );
}

function SchemeEditorMenu(
  props: ConditionalBatchSchemeManagerProps & { selectedStored: boolean },
): React.JSX.Element {
  useTranslation();
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
        label={t("batchEditorCopy.editRule")}
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
          aria-label={t("batchEditorCopy.editRule")}
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
  useTranslation();
  return (
    <>
      <TextField
        label={t("conditionalBatch.scheme.name")}
        value={props.draft.name}
        maxLength={80}
        onChange={(event) =>
          props.onChangeDraft({ ...props.draft, name: event.target.value })
        }
      />
      <TextareaField
        label={t("batchEditorCopy.description")}
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
          aria-label={t("batchEditorCopy.duplicateRule")}
          iconLeft={<IconCopy size={15} />}
          disabled={props.storageBusy}
          onClick={props.onDuplicateScheme}
        >
          {t("common.duplicate")}
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
  useTranslation();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const action = stored ? t("common.delete") : t("codexTypesetting.remove");
  const label = stored
    ? t("conditionalBatch.scheme.delete")
    : t("batchEditorCopy.removeTemporaryRule");
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
          title={
            stored
              ? t("batchEditorCopy.deleteRule")
              : t("batchEditorCopy.removeTemporaryRule")
          }
          message={t("batchEditorMessages.rule", {
            p0: name,
            p1: action,
          })}
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
  if (state === "waiting") return t("batchEditorCopy.waitingToSave");
  if (state === "saving") return t("batchEditorCopy.saving");
  if (state === "saved") return t("batchEditorCopy.autosaved");
  if (state === "error") return t("linkedResults.issue.syncFailed");
  return t("batchEditorCopy.savedRules");
}
