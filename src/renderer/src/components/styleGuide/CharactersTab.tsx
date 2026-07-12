import React from "react";
import { useTranslation } from "react-i18next";
import type {
  CharacterProfile,
  CharacterSpeechStyle,
} from "../../../../shared/workContextTypes";
import { Button } from "../ui/Button";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import {
  makeCharacterProfile,
  nowIso,
  SPEECH_STYLE_IDS,
  splitList,
} from "./styleGuideUtils";

export function CharactersTab({
  guide,
  onGuideChange,
}: StyleGuideEditorProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateCharacter = (
    id: string,
    patch: Partial<CharacterProfile>,
  ): void => {
    onGuideChange({
      ...guide,
      characters: guide.characters.map((character) =>
        character.id === id
          ? { ...character, ...patch, updatedAt: nowIso() }
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
  return (
    <div className="style-guide-content">
      <section className="style-guide-section">
        <div className="style-guide-section-head">
          <h3>{t("styleGuide.characters.title")}</h3>
          <Button size="sm" onClick={addCharacter}>
            {t("styleGuide.addRow")}
          </Button>
        </div>
        {guide.characters.length ? (
          <CharactersTable
            characters={guide.characters}
            onUpdate={updateCharacter}
            onRemove={removeCharacter}
          />
        ) : (
          <p className="style-guide-table-empty">
            {t("styleGuide.characters.empty")}
          </p>
        )}
      </section>
    </div>
  );
}

function CharactersTable({
  characters,
  onUpdate,
  onRemove,
}: {
  characters: CharacterProfile[];
  onUpdate: (id: string, patch: Partial<CharacterProfile>) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-table">
      <div className="style-guide-row character head" aria-hidden="true">
        <span />
        <span>{t("styleGuide.characters.displayName")}</span>
        <span>{t("styleGuide.characters.sourceNames")}</span>
        <span>{t("styleGuide.characters.translatedName")}</span>
        <span>{t("styleGuide.characters.speechStyle")}</span>
        <span>{t("styleGuide.characters.customSpeechStyle")}</span>
        <span>{t("styleGuide.note")}</span>
        <span />
      </div>
      {characters.map((character) => (
        <CharacterRow
          key={character.id}
          character={character}
          onUpdate={(patch) => onUpdate(character.id, patch)}
          onRemove={() => onRemove(character.id)}
        />
      ))}
    </div>
  );
}

function CharacterRow({
  character,
  onUpdate,
  onRemove,
}: {
  character: CharacterProfile;
  onUpdate: (patch: Partial<CharacterProfile>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-row character">
      <label className="inline-toggle">
        <input
          type="checkbox"
          checked={character.enabled}
          onChange={(event) => onUpdate({ enabled: event.target.checked })}
        />
      </label>
      <input
        value={character.displayName}
        placeholder={t("styleGuide.characters.displayName")}
        onChange={(event) => onUpdate({ displayName: event.target.value })}
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
      <Button size="sm" variant="danger" onClick={onRemove}>
        {t("common.delete")}
      </Button>
    </div>
  );
}
