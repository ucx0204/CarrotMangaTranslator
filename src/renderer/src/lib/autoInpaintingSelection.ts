import {
  buildExportSelection,
  createDefaultExportSelection,
  type ExportSelectionMap,
} from "./exportSelection";
import type { AutoInpaintingChapterSelection as SharedAutoInpaintingChapterSelection } from "../../../shared/inpaintingTypes";

export type AutoInpaintingChapterSelection =
  SharedAutoInpaintingChapterSelection;

export type AutoInpaintingSelectionMap = ExportSelectionMap;

export type AutoInpaintingEntryScope = "current" | "all" | "select";

function createDefaultAutoInpaintingSelection(
  chapterId: string,
  currentPageId: string,
): AutoInpaintingSelectionMap {
  return createDefaultExportSelection(chapterId, currentPageId);
}

export function createScopedAutoInpaintingSelection(
  chapterId: string,
  currentPageId: string,
  scope: AutoInpaintingEntryScope,
): AutoInpaintingSelectionMap {
  if (scope === "all") {
    return new Map([[chapterId, { kind: "all" }]]);
  }
  return createDefaultAutoInpaintingSelection(chapterId, currentPageId);
}

export function buildAutoInpaintingSelection(
  chapterOrder: string[],
  selection: AutoInpaintingSelectionMap,
): AutoInpaintingChapterSelection[] {
  return buildExportSelection(chapterOrder, selection);
}
