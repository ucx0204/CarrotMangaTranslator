import type { WorkStyleGuide } from "./workContextTypes";
import type { WorkContextResearchOperation } from "./workContextResearchTypes";

export function createWorkContextResearchFingerprint(
  guide: WorkStyleGuide,
): string {
  const value = JSON.stringify(guide);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

export function applyWorkContextResearchOperations(
  guide: WorkStyleGuide,
  operations: readonly WorkContextResearchOperation[],
): WorkStyleGuide {
  let glossary = guide.glossary;
  let characters = guide.characters;
  for (const operation of operations) {
    if (operation.entity === "glossary") {
      glossary = operation.before
        ? glossary.map((entry) =>
            entry.id === operation.after.id ? operation.after : entry,
          )
        : [...glossary, operation.after];
    } else {
      characters = operation.before
        ? characters.map((entry) =>
            entry.id === operation.after.id ? operation.after : entry,
          )
        : [...characters, operation.after];
    }
  }
  return {
    ...guide,
    glossary,
    characters,
    updatedAt: new Date().toISOString(),
  };
}
