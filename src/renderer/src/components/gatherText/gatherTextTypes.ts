import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";
import type { BlockStylePreset } from "../../../../shared/blockStylePresets";
import type { GatherDirectFormatRequest } from "../../lib/gatherTextFormat";
import type { TranslatedTextImportUpdate } from "../../../../shared/gatherText";

export type GatherTextModalProps = {
  blockStylePresets?: readonly BlockStylePreset[];
  chapter: ChapterSnapshot | null;
  page: MangaPage | null;
  onClose: () => void;
  onChapterUpdated?: (chapter: ChapterSnapshot) => void;
  onApplyTranslatedText?: (updates: TranslatedTextImportUpdate[]) => void;
  onNavigateToBlock?: (pageId: string, blockId: string) => void;
  onOpenBatchEdit?: (initialFind?: string) => void;
  onApplyFormat?: (request: GatherDirectFormatRequest) => void;
  formatApplyDisabled?: boolean;
  readingDirection?: "ltr" | "rtl";
};
