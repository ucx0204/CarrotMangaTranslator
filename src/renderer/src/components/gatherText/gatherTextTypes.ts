import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";

export type GatherTextModalProps = {
  chapter: ChapterSnapshot | null;
  page: MangaPage | null;
  onClose: () => void;
  onChapterUpdated?: (chapter: ChapterSnapshot) => void;
  onApplyTranslatedText?: (
    updates: import("../../lib/gatherText").TranslatedTextImportUpdate[],
  ) => void;
  onNavigateToBlock?: (pageId: string, blockId: string) => void;
  readingDirection?: "ltr" | "rtl";
};
