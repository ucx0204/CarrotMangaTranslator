import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import {
  buildChapterSelectionRequests,
  type BinaryPageSelection,
  type BinaryPageSelectionMap,
} from "./pageSelection";

/** A chapter and the final images selected for one export request. */
export type ExportChapterSelection = PageImageExportChapterSelection;

/**
 * Export has no "untranslated only" notion, so it uses the narrower selection
 * state: a whole chapter, or an explicit page set.
 */
export type ExportChapterSelectionState = BinaryPageSelection;

/** Per-chapter state owned by the export options modal. */
export type ExportSelectionMap = BinaryPageSelectionMap;

export function createDefaultExportSelection(
  chapterId: string,
  _currentPageId: string,
): ExportSelectionMap {
  return new Map([[chapterId, { kind: "all" }]]);
}

/** Builds the public request selection in library chapter order. */
export function buildExportSelection(
  chapterOrder: string[],
  selection: ExportSelectionMap,
): ExportChapterSelection[] {
  return buildChapterSelectionRequests<ExportChapterSelectionState, "all">(
    chapterOrder,
    selection,
    () => "all",
  );
}
