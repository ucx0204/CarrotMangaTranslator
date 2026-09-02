import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import { CharacterContextEntryRow } from "./CharacterContextEntryRow";
import { getCharacterName } from "./characterContextEntryModel";
import { ContextEntrySection } from "./ContextEntryList";
import { ContextEntryTable } from "./ContextEntryTable";
import {
  createContextEntryActions,
  createContextEntryDraftActions,
} from "./contextEntryActions";
import { useContextEntryList } from "./contextEntryListModel";
import {
  createContextEntryTableProps,
  type ContextEntryTableColumn,
} from "./contextEntryTableModel";
import { makeCharacterProfile } from "./styleGuideUtils";
import { useContextEntryDeleteConfirmation } from "./useContextEntryDeleteConfirmation";
import { useContextEntryDraft } from "./useContextEntryDraft";

export function CharactersTab({
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
  const columns = useCharacterColumns();
  const deleteConfirmation = useContextEntryDeleteConfirmation();
  const draft = useCharacterDraft({
    guide,
    onGuideChange,
    draftId,
    onDraftIdChange,
  });
  const entryList = useContextEntryList({
    entries: guide.characters,
    usage,
    usageAvailable,
    getName: getCharacterName,
    getSearchText: (character) =>
      [
        character.displayName,
        character.targetName,
        ...character.sourceNames,
        ...(character.aliases ?? []),
        character.note ?? "",
      ].join(" "),
    pinnedEntryId: draft.draftId,
  });
  const actions = useCharacterActions({
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
        emptyLabel={t("styleGuide.characters.empty")}
        entryList={entryList}
        title={t("styleGuide.characters.title")}
        totalCount={guide.characters.length}
        usageAvailable={usageAvailable}
        onDeleteSelected={() => void actions.removeSelected()}
      >
        <ContextEntryTable
          {...tableProps}
          columns={columns}
          renderRow={(props) => <CharacterContextEntryRow {...props} />}
          rowClassName="character"
        />
      </ContextEntrySection>
      {deleteConfirmation.confirmationModal}
    </>
  );
}

function useCharacterColumns(): readonly ContextEntryTableColumn[] {
  const { t } = useTranslation("components");
  return [
    {
      id: "display-name",
      label: t("styleGuide.characters.displayName"),
    },
    {
      id: "source-names",
      label: t("styleGuide.characters.sourceNames"),
    },
    {
      id: "translated-name",
      label: t("styleGuide.characters.translatedName"),
    },
    {
      id: "speech-style",
      label: t("styleGuide.characters.speechStyle"),
    },
    {
      id: "custom-speech-style",
      label: t("styleGuide.characters.customSpeechStyle"),
    },
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

function useCharacterDraft({
  guide,
  draftId,
  onDraftIdChange,
}: StyleGuideEditorProps & {
  draftId?: string | null;
  onDraftIdChange?: (id: string | null) => void;
}) {
  return useContextEntryDraft({
    entries: guide.characters,
    isComplete: (entry) => Boolean(getCharacterName(entry).trim()),
    draftId,
    onDraftIdChange,
  });
}

function useCharacterActions({
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
    entries: guide.characters,
    selectedIds,
    clearSelection,
    createEntry: makeCharacterProfile,
    confirmDelete,
    onEntriesChange: (characters) => onGuideChange({ ...guide, characters }),
  });
}
