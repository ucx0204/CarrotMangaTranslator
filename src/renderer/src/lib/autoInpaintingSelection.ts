import {
  buildExportSelection,
  createDefaultExportSelection,
  type ExportSelectionMap,
} from "./exportSelection";
import type { AutoInpaintingChapterSelection as SharedAutoInpaintingChapterSelection } from "../../../shared/inpaintingTypes";

export type AutoInpaintingChapterSelection =
  SharedAutoInpaintingChapterSelection;

export type AutoInpaintingSelectionMap = ExportSelectionMap;

export function createDefaultAutoInpaintingSelection(
  chapterId: string,
  currentPageId: string,
): AutoInpaintingSelectionMap {
  return createDefaultExportSelection(chapterId, currentPageId);
}

export function buildAutoInpaintingSelection(
  chapterOrder: string[],
  selection: AutoInpaintingSelectionMap,
): AutoInpaintingChapterSelection[] {
  return buildExportSelection(chapterOrder, selection);
}
