import type { MangaPage } from "./libraryTypes";

const keys = [
  "id",
  "imagePath",
  "width",
  "height",
  "blocks",
  "blockOrder",
  "soundEffectReview",
  "translationCompletion",
  "inpaintedImagePath",
  "inpaintMaskPath",
  "maskProvenance",
] as const;
export type PageRecoverySnapshot = Pick<MangaPage, (typeof keys)[number]>;

/** Saved content only. Running jobs, error messages, timestamps and executable checkpoints
 * are not restored. Optional fields retain their absence, including empty reading order. */
export function capturePageRecovery(
  page: PageRecoverySnapshot,
): PageRecoverySnapshot {
  return structuredClone(
    Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(page, key))
        .map((key) => [key, page[key]]),
    ),
  ) as PageRecoverySnapshot;
}
export function restorePageRecovery<T extends PageRecoverySnapshot>(
  page: T,
  snapshot: PageRecoverySnapshot,
): T {
  const next = { ...page };
  for (const key of keys) Reflect.deleteProperty(next, key);
  return Object.assign(next, structuredClone(snapshot));
}
