import React from "react";
import { useTranslation } from "react-i18next";
import type {
  CharacterProfile,
  CharacterSpeechStyle,
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
import { makeCharacterProfile, SPEECH_STYLE_IDS } from "./styleGuideUtils";
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
        <CharactersTable
          characters={entryList.visibleEntries}
          draftCharacter={draft.draftEntry}
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

function getCharacterName(character: CharacterProfile): string {
  return (
    character.displayName ||
    character.targetName ||
    character.sourceNames.find((value) => value.trim()) ||
    ""
  );
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

type CharactersTableProps = {
  characters: CharacterProfile[];
  draftCharacter?: CharacterProfile;
  draftInputRef: React.RefObject<HTMLInputElement | null>;
  usageById: Map<string, WorkContextUsageMetric>;
  selectedIds: Set<string>;
  allVisibleSelected: boolean;
  onToggleAll: () => void;
  onToggleSelected: (id: string) => void;
  onUpdate: (id: string, patch: Partial<CharacterProfile>) => void;
  onRemove: (id: string) => void;
  onCompleteDraft: () => void;
  onCancelDraft: () => void;
  onAdd: () => void;
  usageAvailable: boolean;
};

function CharactersTable({
  characters,
  draftCharacter,
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
}: CharactersTableProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-table">
      <div className="style-guide-row character head">
        <CheckboxField
          className="inline-toggle"
          checked={allVisibleSelected}
          ariaLabel={t("styleGuide.usage.selectAll")}
          onCheckedChange={() => onToggleAll()}
        />
        <span>{t("styleGuide.characters.displayName")}</span>
        <span>{t("styleGuide.characters.sourceNames")}</span>
        <span>{t("styleGuide.characters.translatedName")}</span>
        <span>{t("styleGuide.characters.speechStyle")}</span>
        <span>{t("styleGuide.characters.customSpeechStyle")}</span>
        <span>{t("styleGuide.note")}</span>
        <span className="style-guide-centered-heading">
          {t("styleGuide.usage.count")}
        </span>
        <span className="style-guide-centered-heading">
          {t("styleGuide.usage.enabled")}
        </span>
        <ContextEntryAddButton onClick={onAdd} />
      </div>
      {draftCharacter ? (
        <CharacterRow
          key={draftCharacter.id}
          character={draftCharacter}
          draft
          primaryInputRef={draftInputRef}
          usage={undefined}
          selected={false}
          onToggleSelected={() => undefined}
          onUpdate={(patch) => onUpdate(draftCharacter.id, patch)}
          onRemove={() => onRemove(draftCharacter.id)}
          onCompleteDraft={onCompleteDraft}
          onCancelDraft={onCancelDraft}
          usageAvailable={usageAvailable}
        />
      ) : null}
      {characters.map((character) => (
        <CharacterRow
          key={character.id}
          character={character}
          usage={usageById.get(character.id)}
          selected={selectedIds.has(character.id)}
          onToggleSelected={() => onToggleSelected(character.id)}
          onUpdate={(patch) => onUpdate(character.id, patch)}
          onRemove={() => onRemove(character.id)}
          usageAvailable={usageAvailable}
        />
      ))}
    </div>
  );
}

type CharacterRowProps = {
  character: CharacterProfile;
  draft?: boolean;
  primaryInputRef?: React.Ref<HTMLInputElement>;
  usage: WorkContextUsageMetric | undefined;
  selected: boolean;
  onToggleSelected: () => void;
  onUpdate: (patch: Partial<CharacterProfile>) => void;
  onRemove: () => void;
  onCompleteDraft?: () => void;
  onCancelDraft?: () => void;
  usageAvailable: boolean;
};

function CharacterRow({
  character,
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
}: CharacterRowProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const name = getCharacterName(character);
  return (
    <div className={`style-guide-row character${draft ? " is-draft" : ""}`}>
      <CharacterPrimaryFields
        character={character}
        draft={draft}
        name={name}
        selected={selected}
        onToggleSelected={onToggleSelected}
        onUpdate={onUpdate}
      />
      <ContextEntryDelimitedInput
        ref={primaryInputRef}
        required={draft && !name.trim()}
        values={character.sourceNames}
        placeholder={t("styleGuide.characters.sourceNames")}
        onValuesChange={(sourceNames) => onUpdate({ sourceNames })}
      />
      <input
        value={character.targetName}
        placeholder={t("styleGuide.characters.translatedName")}
        onChange={(event) => onUpdate({ targetName: event.target.value })}
      />
      <Select
        value={character.speechStyle}
        ariaLabel={t("styleGuide.usage.speechStyleItem", { name })}
        options={SPEECH_STYLE_IDS.map((id) => ({
          value: id,
          label: t(`styleGuide.characters.speechStyles.${id}`),
        }))}
        onValueChange={(nextValue) =>
          onUpdate({ speechStyle: nextValue as CharacterSpeechStyle })
        }
      />
      <input
        value={character.customSpeechStyle ?? ""}
        placeholder={t("styleGuide.characters.customSpeechStyle")}
        onChange={(event) =>
          onUpdate({ customSpeechStyle: event.target.value })
        }
      />
      <input
        value={character.note ?? ""}
        placeholder={t("styleGuide.note")}
        onChange={(event) => onUpdate({ note: event.target.value })}
      />
      <ContextEntryUsageCount metric={usage} usageAvailable={usageAvailable} />
      <ContextEntryEnabledToggle
        enabled={character.enabled}
        name={name}
        onChange={(enabled) => onUpdate({ enabled })}
      />
      <ContextEntryRowActions
        draft={draft}
        name={name}
        onCompleteDraft={onCompleteDraft}
        onCancelDraft={onCancelDraft}
        onRemove={onRemove}
      />
    </div>
  );
}

function CharacterPrimaryFields({
  character,
  draft,
  name,
  selected,
  onToggleSelected,
  onUpdate,
}: {
  character: CharacterProfile;
  draft: boolean;
  name: string;
  selected: boolean;
  onToggleSelected: () => void;
  onUpdate: (patch: Partial<CharacterProfile>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      {draft ? (
        <ContextEntryDraftMarker />
      ) : (
        <CheckboxField
          className="inline-toggle"
          checked={selected}
          ariaLabel={t("styleGuide.usage.selectItem", { name })}
          onCheckedChange={() => onToggleSelected()}
        />
      )}
      <input
        value={character.displayName}
        placeholder={t("styleGuide.characters.displayName")}
        onChange={(event) => onUpdate({ displayName: event.target.value })}
      />
    </>
  );
}
