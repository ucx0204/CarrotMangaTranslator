import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import { ContextEntrySection } from "./ContextEntryList";
import { ContextEntryTable } from "./ContextEntryTable";
import { GlossaryContextEntryRow } from "./GlossaryContextEntryRow";
import {
  createContextEntryActions,
  createContextEntryDraftActions,
} from "./contextEntryActions";
import { useContextEntryList } from "./contextEntryListModel";
import {
  createContextEntryTableProps,
  type ContextEntryTableColumn,
} from "./contextEntryTableModel";
import { makeGlossaryEntry } from "./styleGuideUtils";
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
  const columns = useGlossaryColumns();
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
  const tableProps = createContextEntryTableProps({
    actions,
    draft,
    draftActions,
    entryList,
    usageAvailable,
  });
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
        <ContextEntryTable
          {...tableProps}
          columns={columns}
          renderRow={(props) => <GlossaryContextEntryRow {...props} />}
          rowClassName="glossary"
        />
      </ContextEntrySection>
      {deleteConfirmation.confirmationModal}
    </>
  );
}

function useGlossaryColumns(): readonly ContextEntryTableColumn[] {
  const { t } = useTranslation("components");
  return [
    { id: "source", label: t("styleGuide.glossary.source") },
    {
      id: "translation",
      label: t("styleGuide.glossary.translation"),
    },
    { id: "category", label: t("styleGuide.glossary.category") },
    { id: "aliases", label: t("styleGuide.glossary.aliases") },
    { id: "note", label: t("styleGuide.note") },
    {
      id: "usage-count",
      label: t("styleGuide.usage.count"),
      centered: true,
    },
    {
      id: "enabled",
      label: t("styleGuide.usage.enabled"),
      centered: true,
    },
  ];
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
