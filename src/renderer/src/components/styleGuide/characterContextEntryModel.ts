import type { CharacterProfile } from "../../../../shared/workContextTypes";

export function getCharacterName(character: CharacterProfile): string {
  return (
    character.displayName ||
    character.targetName ||
    character.sourceNames.find((value) => value.trim()) ||
    ""
  );
}
