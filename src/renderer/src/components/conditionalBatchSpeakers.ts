import React from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { CharacterProfile } from "../../../shared/workContextTypes";
import type { SelectOption } from "./ui/selectTypes";

export type ConditionalBatchSpeakerCatalog = {
  options: readonly (SelectOption & { label: string })[];
  unassignedCount: number;
  ready: boolean;
  error: string | null;
};

export const ConditionalBatchSpeakersContext =
  React.createContext<ConditionalBatchSpeakerCatalog>({
    options: [],
    unassignedCount: 0,
    ready: true,
    error: null,
  });

export function createConditionalBatchSpeakerCatalog(
  chapter: ChapterSnapshot,
  characters: readonly CharacterProfile[],
  ready: boolean,
  error: string | null,
): ConditionalBatchSpeakerCatalog {
  const counts = new Map<string, number>();
  let unassignedCount = 0;
  for (const block of chapter.pages.flatMap((page) => page.blocks)) {
    if (!block.speakerId?.trim()) unassignedCount += 1;
    else counts.set(block.speakerId, (counts.get(block.speakerId) ?? 0) + 1);
  }
  const names = new Map<string, number>();
  for (const character of characters) {
    const name = characterName(character);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const options = characters.map((character) => {
    const name = characterName(character);
    const label =
      (names.get(name) ?? 0) > 1 ? `${name} · ${character.id}` : name;
    const count = counts.get(character.id) ?? 0;
    counts.delete(character.id);
    return {
      value: character.id,
      label,
      tooltip: label,
      group: "작품의 인물",
      description: `이 화의 대사 ${count}개${character.enabled ? "" : " · 인물 정보 비활성"}`,
      searchText: [
        name,
        character.id,
        character.displayName,
        ...character.sourceNames,
        ...(character.aliases ?? []),
      ].join(" "),
    };
  });
  for (const [id, count] of counts) {
    options.push({
      value: id,
      label: `이름 미등록 · ${id}`,
      tooltip: id,
      group: "이 화에 연결된 화자",
      description: `이 화의 대사 ${count}개`,
      searchText: id,
    });
  }
  return { options, unassignedCount, ready, error };
}

function characterName(character: CharacterProfile): string {
  return (
    character.targetName.trim() ||
    character.displayName.trim() ||
    character.sourceNames[0]?.trim() ||
    character.id
  );
}
