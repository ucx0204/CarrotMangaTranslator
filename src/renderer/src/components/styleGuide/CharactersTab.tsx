import React from "react";
import { useTranslation } from "react-i18next";
import type {
  CharacterProfile,
  CharacterSpeechStyle,
} from "../../../../shared/workContextTypes";
import type { WorkContextUsageMetric } from "../../../../shared/workContextUsageTypes";
import { Button } from "../ui/Button";
import { CheckboxField } from "../ui/CheckboxField";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import {
  ContextEntryDeleteButton,
  ContextEntryEnabledToggle,
  ContextEntryToolbar,
  ContextEntryUsageCount,
} from "./ContextEntryList";
import { useContextEntryList } from "./contextEntryListModel";
import {
  makeCharacterProfile,
  nowIso,
  SPEECH_STYLE_IDS,
  splitList,
} from "./styleGuideUtils";

export function CharactersTab({
  guide,
  onGuideChange,
  usage = [],
  usageAvailable = true,
}: StyleGuideEditorProps & {
  usage?: WorkContextUsageMetric[];
  usageAvailable?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const entryList = useContextEntryList({
    entries: guide.characters,
    usage,
    usageAvailable,
    getName: (character) =>
      character.displayName ||
      character.targetName ||
      character.sourceNames[0] ||
      "",
    getSearchText: (character) =>
      [
        character.displayName,
        character.targetName,
        ...character.sourceNames,
        ...(character.aliases ?? []),
        character.note ?? "",
      ].join(" "),
  });
  const actions = useCharacterActions({
    guide,
    onGuideChange,
    selectedIds: entryList.selectedIds,
    clearSelection: () => entryList.setSelectedIds(new Set()),
  });
  return (
    <div className="style-guide-content">
      <section className="style-guide-section">
        <div className="style-guide-section-head">
          <h3>{t("styleGuide.characters.title")}</h3>
          <Button size="sm" onClick={actions.addCharacter}>
            {t("styleGuide.addRow")}
          </Button>
        </div>
        <ContextEntryToolbar
          query={entryList.query}
          onQueryChange={entryList.setQuery}
          filter={entryList.filter}
          onFilterChange={entryList.setFilter}
          sort={entryList.sort}
          onSortChange={entryList.setSort}
          selectedCount={entryList.selectedIds.size}
          onDeleteSelected={actions.removeSelected}
          usageAvailable={usageAvailable}
        />
        {entryList.visibleEntries.length ? (
          <CharactersTable
            characters={entryList.visibleEntries}
            usageById={entryList.usageById}
            selectedIds={entryList.selectedIds}
            allVisibleSelected={entryList.allVisibleSelected}
            onToggleAll={entryList.toggleAllVisible}
            onToggleSelected={entryList.toggleSelected}
            onUpdate={actions.updateCharacter}
            onRemove={actions.removeCharacter}
            usageAvailable={usageAvailable}
          />
        ) : (
          <p className="style-guide-table-empty">
            {t(
              guide.characters.length
                ? "styleGuide.usage.noMatches"
                : "styleGuide.characters.empty",
            )}
          </p>
        )}
      </section>
    </div>
  );
}

function useCharacterActions({
  guide,
  onGuideChange,
  selectedIds,
  clearSelection,
}: StyleGuideEditorProps & {
  selectedIds: Set<string>;
  clearSelection: () => void;
}) {
  const { t } = useTranslation("components");
  const updateCharacter = (
    id: string,
    patch: Partial<CharacterProfile>,
  ): void => {
    onGuideChange({
      ...guide,
      characters: guide.characters.map((character) =>
        character.id === id
          ? { ...character, ...patch, origin: "manual", updatedAt: nowIso() }
          : character,
      ),
    });
  };
  const addCharacter = (): void => {
    onGuideChange({
      ...guide,
      characters: [...guide.characters, makeCharacterProfile()],
    });
  };
  const removeCharacter = (id: string): void => {
    onGuideChange({
      ...guide,
      characters: guide.characters.filter((character) => character.id !== id),
    });
  };
  const removeSelected = (): void => {
    const confirmed = window.confirm(
      t("styleGuide.usage.deleteConfirm", { count: selectedIds.size }),
    );
    if (!confirmed) return;
    onGuideChange({
      ...guide,
      characters: guide.characters.filter(
        (character) => !selectedIds.has(character.id),
      ),
    });
    clearSelection();
  };
  return {
    addCharacter,
    removeCharacter,
    removeSelected,
    updateCharacter,
  };
}

function CharactersTable({
  characters,
  usageById,
  selectedIds,
  allVisibleSelected,
  onToggleAll,
  onToggleSelected,
  onUpdate,
  onRemove,
  usageAvailable,
}: {
  characters: CharacterProfile[];
  usageById: Map<string, WorkContextUsageMetric>;
  selectedIds: Set<string>;
  allVisibleSelected: boolean;
  onToggleAll: () => void;
  onToggleSelected: (id: string) => void;
  onUpdate: (id: string, patch: Partial<CharacterProfile>) => void;
  onRemove: (id: string) => void;
  usageAvailable: boolean;
}): React.JSX.Element {
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
        <span />
      </div>
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

function CharacterRow({
  character,
  usage,
  selected,
  onToggleSelected,
  onUpdate,
  onRemove,
  usageAvailable,
}: {
  character: CharacterProfile;
  usage: WorkContextUsageMetric | undefined;
  selected: boolean;
  onToggleSelected: () => void;
  onUpdate: (patch: Partial<CharacterProfile>) => void;
  onRemove: () => void;
  usageAvailable: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const name =
    character.displayName ||
    character.targetName ||
    character.sourceNames[0] ||
    "";
  return (
    <div className="style-guide-row character">
      <CharacterPrimaryFields
        character={character}
        name={name}
        selected={selected}
        onToggleSelected={onToggleSelected}
        onUpdate={onUpdate}
      />
      <input
        value={character.sourceNames.join(", ")}
        placeholder={t("styleGuide.characters.sourceNames")}
        onChange={(event) =>
          onUpdate({ sourceNames: splitList(event.target.value) })
        }
      />
      <input
        value={character.targetName}
        placeholder={t("styleGuide.characters.translatedName")}
        onChange={(event) => onUpdate({ targetName: event.target.value })}
      />
      <select
        value={character.speechStyle}
        aria-label={t("styleGuide.usage.speechStyleItem", { name })}
        onChange={(event) =>
          onUpdate({ speechStyle: event.target.value as CharacterSpeechStyle })
        }
      >
        {SPEECH_STYLE_IDS.map((id) => (
          <option key={id} value={id}>
            {t(`styleGuide.characters.speechStyles.${id}`)}
          </option>
        ))}
      </select>
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
      <ContextEntryDeleteButton name={name} onClick={onRemove} />
    </div>
  );
}

function CharacterPrimaryFields({
  character,
  name,
  selected,
  onToggleSelected,
  onUpdate,
}: {
  character: CharacterProfile;
  name: string;
  selected: boolean;
  onToggleSelected: () => void;
  onUpdate: (patch: Partial<CharacterProfile>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <CheckboxField
        className="inline-toggle"
        checked={selected}
        ariaLabel={t("styleGuide.usage.selectItem", { name })}
        onCheckedChange={() => onToggleSelected()}
      />
      <input
        value={character.displayName}
        placeholder={t("styleGuide.characters.displayName")}
        onChange={(event) => onUpdate({ displayName: event.target.value })}
      />
    </>
  );
}
