import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GlossaryEntry,
  GlossaryEntryCategory,
} from "../../../../shared/workContextTypes";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import {
  ContextEntryAddButton,
  ContextEntryDelimitedInput,
  ContextEntryDraftMarker,
  ContextEntryEnabledToggle,
  ContextEntryRowActions,
  ContextEntrySection,
  ContextEntryUsageCount,
} from "./ContextEntryList";
import {
  createContextEntryActions,
  createContextEntryDraftActions,
} from "./contextEntryActions";
import { useContextEntryList } from "./contextEntryListModel";
import { CATEGORY_IDS, makeGlossaryEntry } from "./styleGuideUtils";
import { useContextEntryDeleteConfirmation } from "./useContextEntryDeleteConfirmation";
import { useContextEntryDraft } from "./useContextEntryDraft";

export function GlossaryTab({
  guide,
  onGuideChange,
  usage = [],
  usageAvailable = true,
  draftId,
  onDraftIdChange,
}: StyleGuideEditorProps & {
  usage?: WorkContextUsageMetric[];
  usageAvailable?: boolean;
  draftId?: string | null;
  onDraftIdChange?: (id: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const deleteConfirmation = useContextEntryDeleteConfirmation();
  const draft = useContextEntryDraft({
    entries: guide.glossary,
    isComplete: (entry) => Boolean(entry.source.trim()),
    draftId,
    onDraftIdChange,
  });
  const entryList = useContextEntryList({
    entries: guide.glossary,
    usage,
    usageAvailable,
    getName: (entry) => entry.source || entry.target,
    getSearchText: (entry) =>
      [
        entry.source,
        entry.target,
        ...(entry.aliases ?? []),
        entry.note ?? "",
      ].join(" "),
    pinnedEntryId: draft.draftId,
  });
  const actions = useGlossaryActions({
    guide,
    onGuideChange,
    selectedIds: entryList.selectedIds,
    clearSelection: () => entryList.setSelectedIds(new Set()),
    confirmDelete: deleteConfirmation.confirmDelete,
  });
  const draftActions = createContextEntryDraftActions({ actions, draft });
  return (
    <>
      <ContextEntrySection
        emptyLabel={t("styleGuide.glossary.empty")}
        entryList={entryList}
        title={t("styleGuide.tabs.glossary")}
        totalCount={guide.glossary.length}
        usageAvailable={usageAvailable}
        notice={t("styleGuide.glossary.omissionHint")}
        onDeleteSelected={() => void actions.removeSelected()}
      >
        <GlossaryTable
          entries={entryList.visibleEntries}
          draftEntry={draft.draftEntry}
          draftInputRef={draft.primaryInputRef}
          usageById={entryList.usageById}
          selectedIds={entryList.selectedIds}
          allVisibleSelected={entryList.allVisibleSelected}
          onToggleAll={entryList.toggleAllVisible}
          onToggleSelected={entryList.toggleSelected}
          onUpdate={actions.update}
          onRemove={actions.remove}
          onCompleteDraft={draftActions.complete}
          onCancelDraft={draftActions.cancel}
          onAdd={draftActions.add}
          usageAvailable={usageAvailable}
        />
      </ContextEntrySection>
      {deleteConfirmation.confirmationModal}
    </>
  );
}

function useGlossaryActions({
  guide,
  onGuideChange,
  selectedIds,
  clearSelection,
  confirmDelete,
}: StyleGuideEditorProps & {
  selectedIds: Set<string>;
  clearSelection: () => void;
  confirmDelete: (count: number) => Promise<boolean>;
}) {
  return createContextEntryActions({
    entries: guide.glossary,
    selectedIds,
    clearSelection,
    createEntry: () =>
      makeGlossaryEntry({ source: "", target: "", category: "term" }),
    confirmDelete,
    onEntriesChange: (glossary) => onGuideChange({ ...guide, glossary }),
  });
}

type GlossaryTableProps = {
  entries: GlossaryEntry[];
  draftEntry?: GlossaryEntry;
  draftInputRef: React.RefObject<HTMLInputElement | null>;
  usageById: Map<string, WorkContextUsageMetric>;
  selectedIds: Set<string>;
  allVisibleSelected: boolean;
  onToggleAll: () => void;
  onToggleSelected: (id: string) => void;
  onUpdate: (id: string, patch: Partial<GlossaryEntry>) => void;
  onRemove: (id: string) => void;
  onCompleteDraft: () => void;
  onCancelDraft: () => void;
  onAdd: () => void;
  usageAvailable: boolean;
};

function GlossaryTable({
  entries,
  draftEntry,
  draftInputRef,
  usageById,
  selectedIds,
  allVisibleSelected,
  onToggleAll,
  onToggleSelected,
  onUpdate,
  onRemove,
  onCompleteDraft,
  onCancelDraft,
  onAdd,
  usageAvailable,
}: GlossaryTableProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-table">
      <div className="style-guide-row glossary head">
        <CheckboxField
          className="inline-toggle"
          checked={allVisibleSelected}
          ariaLabel={t("styleGuide.usage.selectAll")}
          onCheckedChange={() => onToggleAll()}
        />
        <span>{t("styleGuide.glossary.source")}</span>
        <span>{t("styleGuide.glossary.translation")}</span>
        <span>{t("styleGuide.glossary.category")}</span>
        <span>{t("styleGuide.glossary.aliases")}</span>
        <span>{t("styleGuide.note")}</span>
        <span className="style-guide-centered-heading">
          {t("styleGuide.usage.count")}
        </span>
        <span className="style-guide-centered-heading">
          {t("styleGuide.usage.enabled")}
        </span>
        <ContextEntryAddButton onClick={onAdd} />
      </div>
      {draftEntry ? (
        <GlossaryRow
          key={draftEntry.id}
          entry={draftEntry}
          draft
          primaryInputRef={draftInputRef}
          usage={undefined}
          selected={false}
          onToggleSelected={() => undefined}
          onUpdate={(patch) => onUpdate(draftEntry.id, patch)}
          onRemove={() => onRemove(draftEntry.id)}
          onCompleteDraft={onCompleteDraft}
          onCancelDraft={onCancelDraft}
          usageAvailable={usageAvailable}
        />
      ) : null}
      {entries.map((entry) => (
        <GlossaryRow
          key={entry.id}
          entry={entry}
          usage={usageById.get(entry.id)}
          selected={selectedIds.has(entry.id)}
          onToggleSelected={() => onToggleSelected(entry.id)}
          onUpdate={(patch) => onUpdate(entry.id, patch)}
          onRemove={() => onRemove(entry.id)}
          usageAvailable={usageAvailable}
        />
      ))}
    </div>
  );
}

type GlossaryRowProps = {
  entry: GlossaryEntry;
  draft?: boolean;
  primaryInputRef?: React.Ref<HTMLInputElement>;
  usage: WorkContextUsageMetric | undefined;
  selected: boolean;
  onToggleSelected: () => void;
  onUpdate: (patch: Partial<GlossaryEntry>) => void;
  onRemove: () => void;
  onCompleteDraft?: () => void;
  onCancelDraft?: () => void;
  usageAvailable: boolean;
};

function GlossaryRow({
  entry,
  draft = false,
  primaryInputRef,
  usage,
  selected,
  onToggleSelected,
  onUpdate,
  onRemove,
  onCompleteDraft,
  onCancelDraft,
  usageAvailable,
}: GlossaryRowProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const entryName = entry.source || entry.target;
  return (
    <div className={`style-guide-row glossary${draft ? " is-draft" : ""}`}>
      {draft ? (
        <ContextEntryDraftMarker />
      ) : (
        <CheckboxField
          className="inline-toggle"
          checked={selected}
          ariaLabel={t("styleGuide.usage.selectItem", { name: entryName })}
          onCheckedChange={() => onToggleSelected()}
        />
      )}
      <input
        ref={primaryInputRef}
        required={draft}
        value={entry.source}
        placeholder={t("styleGuide.glossary.source")}
        onChange={(event) => onUpdate({ source: event.target.value })}
      />
      <input
        value={entry.target}
        placeholder={t("styleGuide.glossary.translation")}
        onChange={(event) => onUpdate({ target: event.target.value })}
      />
      <Select
        value={entry.category}
        ariaLabel={t("styleGuide.usage.categoryItem", {
          name: entryName,
        })}
        options={CATEGORY_IDS.map((id) => ({
          value: id,
          label: t(`styleGuide.glossary.categories.${id}`),
        }))}
        onValueChange={(nextValue) =>
          onUpdate({ category: nextValue as GlossaryEntryCategory })
        }
      />
      <ContextEntryDelimitedInput
        values={entry.aliases ?? []}
        placeholder={t("styleGuide.glossary.aliases")}
        onValuesChange={(aliases) => onUpdate({ aliases })}
      />
      <input
        value={entry.note ?? ""}
        placeholder={t("styleGuide.note")}
        onChange={(event) => onUpdate({ note: event.target.value })}
      />
      <ContextEntryUsageCount metric={usage} usageAvailable={usageAvailable} />
      <ContextEntryEnabledToggle
        enabled={entry.enabled}
        name={entryName}
        onChange={(enabled) => onUpdate({ enabled })}
      />
      <ContextEntryRowActions
        draft={draft}
        name={entryName}
        onCompleteDraft={onCompleteDraft}
        onCancelDraft={onCancelDraft}
        onRemove={onRemove}
      />
    </div>
  );
}
