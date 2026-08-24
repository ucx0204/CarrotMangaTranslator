import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";
import type { BlockStylePreset } from "../../../../shared/blockStylePresets";
import type { GatherDirectFormatRequest } from "../../lib/gatherTextFormat";
import type {
  GatherTextTab,
  TranslatedTextImportUpdate,
} from "../../lib/gatherText";
import type { SearchReplaceRequest } from "../../lib/searchReplace";

export type GatherTextModalProps = {
  blockStylePresets?: readonly BlockStylePreset[];
  activeTab?: GatherTextTab;
  chapter: ChapterSnapshot | null;
  page: MangaPage | null;
  onClose: () => void;
  onTabChange?: (tab: GatherTextTab) => void;
  onChapterUpdated?: (chapter: ChapterSnapshot) => void;
  onApplyTranslatedText?: (updates: TranslatedTextImportUpdate[]) => void;
  onApplySearchReplace?: (request: SearchReplaceRequest) => void;
  onNavigateToBlock?: (pageId: string, blockId: string) => void;
  onApplyFormat?: (request: GatherDirectFormatRequest) => void;
  formatApplyDisabled?: boolean;
  searchReplaceDisabled?: boolean;
  readingDirection?: "ltr" | "rtl";
};
