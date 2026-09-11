import type { MangaPage } from "./libraryTypes";
import { hashStableValue } from "./blockFingerprint";
import { createPageRevision } from "./pageRevision";
/** Adds user ordering to the existing full-content revision; no protected algorithm is changed. */
export function createPageEditingRevision(page: MangaPage): string {
  return `page-edit-v1:${hashStableValue({ content: createPageRevision(page), order: page.blockOrder })}`;
}
