import type { MangaPage } from "./libraryTypes";

const keys = [
  "blocks",
  "blockOrder",
  "soundEffectReview",
  "translationCompletion",
  "analysisStatus",
  "lastError",
] as const;
export type SoundEffectPageSnapshot = Pick<MangaPage, (typeof keys)[number]>;
/** Internal native editing state, never a transport input. Preserve optional-field absence. */
export function captureSoundEffectPage(
  page: SoundEffectPageSnapshot,
): SoundEffectPageSnapshot {
  return structuredClone(
    Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(page, key))
        .map((key) => [key, page[key]]),
    ),
  ) as SoundEffectPageSnapshot;
}
export function restoreSoundEffectPage<T extends SoundEffectPageSnapshot>(
  page: T,
  state: SoundEffectPageSnapshot,
): T {
  const next = { ...page };
  for (const key of keys) Reflect.deleteProperty(next, key);
  return Object.assign(next, structuredClone(state));
}
