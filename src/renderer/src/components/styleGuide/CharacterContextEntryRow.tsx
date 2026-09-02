import React from "react";
import { useTranslation } from "react-i18next";
import type {
  CharacterProfile,
  CharacterSpeechStyle,
} from "../../../../shared/workContextTypes";
import { CheckboxField } from "../ui/CheckboxField";
import { Select } from "../ui/Select";
import { getCharacterName } from "./characterContextEntryModel";
import {
  ContextEntryDelimitedInput,
  ContextEntryDraftMarker,
  ContextEntryEnabledToggle,
  ContextEntryRowActions,
  ContextEntryUsageCount,
} from "./ContextEntryList";
import type { ContextEntryTableRowProps } from "./contextEntryTableModel";
import { SPEECH_STYLE_IDS } from "./styleGuideUtils";

export function CharacterContextEntryRow({
  entry: character,
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
}: ContextEntryTableRowProps<CharacterProfile>): React.JSX.Element {
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
          onCheckedChange={onToggleSelected}
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
