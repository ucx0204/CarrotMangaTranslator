import type { MangaPage } from "../../../../shared/libraryTypes";
import type { PageStatusMode } from "./pageListStatus";

export type SortablePageItemProps = {
  page: MangaPage;
  selected: boolean;
  disabled: boolean;
  locked: boolean;
  statusMode: PageStatusMode;
  onSelect: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onRemove: (pageId: string) => void;
  registerRef: (pageId: string, element: HTMLDivElement | null) => void;
};

export function buildPageListClassName(
  hasPages: boolean,
  collapsed: boolean,
): string {
  return ["page-list", hasPages ? "" : "empty", collapsed ? "collapsed" : ""]
    .filter(Boolean)
    .join(" ");
}

export function areSortablePageItemPropsEqual(
  previous: SortablePageItemProps,
  next: SortablePageItemProps,
): boolean {
  return (
    arePageItemBindingsEqual(previous, next) &&
    arePageRowValuesEqual(previous.page, next.page)
  );
}

function arePageItemBindingsEqual(
  previous: SortablePageItemProps,
  next: SortablePageItemProps,
): boolean {
  return (
    previous.disabled === next.disabled &&
    previous.locked === next.locked &&
    previous.onRemove === next.onRemove &&
    previous.onRetranslate === next.onRetranslate &&
    previous.onSelect === next.onSelect &&
    previous.registerRef === next.registerRef &&
    previous.selected === next.selected &&
    previous.statusMode === next.statusMode
  );
}

function arePageRowValuesEqual(previous: MangaPage, next: MangaPage): boolean {
  return (
    previous.id === next.id &&
    previous.name === next.name &&
    previous.analysisStatus === next.analysisStatus &&
    previous.blocks === next.blocks &&
    previous.translationCompletion === next.translationCompletion &&
    previous.imagePath === next.imagePath &&
    previous.inpaintedImagePath === next.inpaintedImagePath
  );
}
