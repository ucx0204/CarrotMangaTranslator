import type {
  CharacterProfile,
  GlossaryEntry,
} from "../shared/workContextTypes";

export function findGlossaryByName(
  entries: GlossaryEntry[],
  name: string,
): GlossaryEntry | undefined {
  const key = normalizeIdentity(name);
  return entries.find((entry) =>
    [entry.source, ...(entry.aliases ?? [])].some(
      (candidate) => normalizeIdentity(candidate) === key,
    ),
  );
}

export function findCharacterByNames(
  entries: CharacterProfile[],
  names: string[],
): CharacterProfile | undefined {
  const keys = new Set(names.map(normalizeIdentity).filter(Boolean));
  if (keys.size === 0) return undefined;
  return entries.find((entry) =>
    [
      entry.displayName,
      entry.targetName,
      ...entry.sourceNames,
      ...(entry.aliases ?? []),
    ].some((candidate) => keys.has(normalizeIdentity(candidate))),
  );
}

export function isManual(entry: GlossaryEntry | CharacterProfile): boolean {
  return entry.origin !== "ai";
}

function normalizeIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s・･·._\-()[\]【】]/g, "");
}
