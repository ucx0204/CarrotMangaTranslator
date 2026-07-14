import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";
import { applyTranslatedTextUpdates } from "./applyTranslatedTextUpdates";
import { applyGatherTextFormatRequest } from "./applyGatherTextFormatRequest";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";

export function createGatherTextProps({
  core,
  derivedState,
  inpaintingBridge,
  libraryActions,
  pageNavigationHandlers,
  settingsDialog,
  uiState,
  updateCurrentChapter,
  workspaceHistory,
}: AppSessionViewModel): AppSessionViewProps["gatherTextProps"] {
  const formatApplyDisabled =
    derivedState.jobActive ||
    inpaintingBridge.contextValue.jobActive ||
    uiState.translationFlowActive ||
    workspaceHistory.busy;
  return uiState.textViewOpen
    ? {
        chapter: core.currentChapter,
        formatApplyDisabled,
        onApplyFormat: (request) => {
          if (formatApplyDisabled) return;
          applyGatherTextFormatRequest(
            core.currentChapter,
            request,
            updateCurrentChapter,
          );
        },
        onApplyTranslatedText: (updates) =>
          applyTranslatedTextUpdates(updates, updateCurrentChapter),
        onChapterUpdated: (updatedChapter) => {
          workspaceHistory.reset();
          libraryActions.applyChapter(updatedChapter);
        },
        onClose: () => uiState.setTextViewOpen(false),
        onNavigateToBlock: (pageId, blockId) => {
          pageNavigationHandlers.selectPageForReading(pageId);
          core.selectedBlockIdRef.current = blockId;
          core.setSelectedBlockId(blockId);
          core.setSelectedBlockIds([blockId]);
          uiState.setTextViewOpen(false);
        },
        page: derivedState.selectedPage,
        readingDirection: resolveSourceReadingDirection(
          settingsDialog.settings?.translation?.sourceLanguage,
        ),
      }
    : null;
}
