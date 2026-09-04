import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";
import { resolveReadingDirection } from "../../../../shared/blockReadingOrder";
import { applyTranslatedTextUpdates } from "./applyTranslatedTextUpdates";
import { applyGatherTextFormatRequest } from "./applyGatherTextFormatRequest";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { isChapterMutationBlocked } from "./workspaceActivity";

export function createGatherTextProps(
  model: AppSessionViewModel,
): AppSessionViewProps["gatherTextProps"] {
  const {
    core,
    derivedState,
    libraryActions,
    pageNavigationHandlers,
    settingsDialog,
    uiState,
    updateCurrentChapter,
    workspaceHistory,
  } = model;
  const mutationDisabled = isChapterMutationBlocked(model);
  return uiState.textViewOpen
    ? {
        blockStylePresets: settingsDialog.settings?.blockStylePresets ?? [],
        chapter: core.currentChapter,
        formatApplyDisabled: mutationDisabled,
        onApplyFormat: (request) => {
          if (isChapterMutationBlocked(model)) return;
          applyGatherTextFormatRequest(
            core.currentChapter,
            request,
            updateCurrentChapter,
          );
        },
        onApplyTranslatedText: (updates) => {
          if (isChapterMutationBlocked(model)) return;
          applyTranslatedTextUpdates(updates, updateCurrentChapter);
        },
        onChapterUpdated: (updatedChapter) => {
          if (isChapterMutationBlocked(model)) return;
          workspaceHistory.reset();
          libraryActions.applyChapter(updatedChapter);
        },
        onClose: () => uiState.setTextViewOpen(false),
        onOpenBatchEdit: (initialFind) => {
          uiState.setConditionalBatchInitialFind(initialFind?.trim() ?? "");
          uiState.setConditionalBatchInitialReplace("");
          uiState.setConditionalBatchOpen(true);
        },
        onNavigateToBlock: (pageId, blockId) => {
          pageNavigationHandlers.selectPageForReading(pageId);
          core.selectedBlockIdRef.current = blockId;
          core.setSelectedBlockId(blockId);
          core.setSelectedBlockIds([blockId]);
          uiState.setRightRailMode("block-editor");
          uiState.setTextViewOpen(false);
        },
        page: derivedState.selectedPage,
        readingDirection: resolveReadingDirection(
          core.library.works.find(
            (work) => work.id === core.currentChapter?.workId,
          )?.readingDirection,
          resolveSourceReadingDirection(
            settingsDialog.settings?.translation?.sourceLanguage,
          ),
        ),
      }
    : null;
}
