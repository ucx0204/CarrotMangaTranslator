import type { Dispatch, RefObject, SetStateAction } from "react";
import type { BlockReadingDirection } from "../../../shared/blockReadingOrder";
import type { BlockStylePreset } from "../../../shared/blockStylePresets";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { FontSizeAdjustment } from "../lib/blockFontSizeAdjustment";
import type { summarizeBlockStylePresets } from "../../../shared/blockStylePresets";
import type { FormatApplyScope } from "./blockEditingStatus";
import type { BlockBackgroundApplyScope } from "./useApplyBlockBackgroundOpacityAction";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import type { BlockLibraryEntryV1 } from "../../../shared/blockLibrary";

export type UseBlockEditingActionsOptions = {
  availableFontIds?: ReadonlySet<string>;
  blockStylePresets?: readonly BlockStylePreset[];
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  pushStatus: (line: string) => void;
  readingDirection?: BlockReadingDirection;
  selectedBlock: TranslationBlock | null;
  selectedBlockIds: string[];
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  stageRef?: RefObject<HTMLDivElement | null>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  updateCurrentChapter: UpdateCurrentChapter;
};

export type BlockEditingActions = {
  insertBlockLibraryEntry: (entry: BlockLibraryEntryV1) => void;
  adjustSelectedBlockFontSize: (adjustment: FontSizeAdjustment) => void;
  adjustSelectedBlocksFontSize: (adjustment: FontSizeAdjustment) => void;
  applyBlockBackgroundOpacityToScope: (
    scope: BlockBackgroundApplyScope,
  ) => void;
  applyFormatToScope: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  applyStylePreset: (presetId: string) => void;
  deleteSelectedBlock: () => void;
  duplicateSelectedBlock: () => void;
  moveSelectedBlockInReadingOrder: (
    direction: -1 | 1,
    blockId?: string,
  ) => void;
  nudgeSelectedBlocks: (deltaPx: { x: number; y: number }) => void;
  removeSelectedBlockBubbleLayout: () => void;
  toggleBlockInpaintExcluded: (blockId: string) => void;
  updateBlock: (blockId: string, patch: Partial<TranslationBlock>) => void;
  updateSelectedBlock: (patch: Partial<TranslationBlock>) => void;
  updateSelectedBlocks: (patch: Partial<TranslationBlock>) => void;
  stylePresetSummaries: ReturnType<typeof summarizeBlockStylePresets>;
  sortPageReadingOrder: () => void;
};
