import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";
import { resolveReadingDirection } from "../../../../shared/blockReadingOrder";
import { appI18n } from "../../appI18n";
import { applySearchReplace } from "../../lib/searchReplace";
import type { SearchReplaceRequest } from "../../lib/searchReplace";
import { toast } from "../../lib/toastStore";
import { applyTranslatedTextUpdates } from "./applyTranslatedTextUpdates";
import { applyGatherTextFormatRequest } from "./applyGatherTextFormatRequest";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";

export function createGatherTextProps(
  model: AppSessionViewModel,
): AppSessionViewProps["gatherTextProps"] {
  const {
    core,
    derivedState,
    inpaintingBridge,
    libraryActions,
    pageNavigationHandlers,
    settingsDialog,
    uiState,
    updateCurrentChapter,
    workspaceHistory,
  } = model;
  const formatApplyDisabled =
    derivedState.jobActive ||
    inpaintingBridge.contextValue.jobActive ||
    uiState.translationFlowActive ||
    workspaceHistory.busy;
  return uiState.textViewOpen
    ? {
        chapter: core.currentChapter,
        activeTab: uiState.textViewTab,
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
        onApplySearchReplace: (request) => handleSearchReplace(model, request),
        onChapterUpdated: (updatedChapter) => {
          workspaceHistory.reset();
          libraryActions.applyChapter(updatedChapter);
        },
        onClose: () => uiState.setTextViewOpen(false),
        onTabChange: uiState.setTextViewTab,
        onNavigateToBlock: (pageId, blockId) => {
          pageNavigationHandlers.selectPageForReading(pageId);
          core.selectedBlockIdRef.current = blockId;
          core.setSelectedBlockId(blockId);
          core.setSelectedBlockIds([blockId]);
          uiState.setRightRailMode("block-editor");
          uiState.setTextViewOpen(false);
        },
        page: derivedState.selectedPage,
        searchReplaceDisabled:
          derivedState.selectedPageEditLocked || workspaceHistory.busy,
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

function handleSearchReplace(
  model: AppSessionViewModel,
  request: SearchReplaceRequest,
): void {
  const { core, derivedState, statusLog, updateCurrentChapter } = model;
  const chapter = core.currentChapter;
  if (!chapter) return;
  const result = applySearchReplace(
    chapter,
    derivedState.selectedPage?.id ?? null,
    request,
  );
  const firstChangedPageId = result.changedPageIds[0];
  if (!firstChangedPageId) return;
  updateCurrentChapter(firstChangedPageId, () => result.chapter, {
    dirtyPageIds: result.changedPageIds,
    label: appI18n.t("workspaceHistory.searchReplace", { ns: "renderer" }),
  });
  const message = appI18n.t("searchReplace.replaced", {
    ns: "renderer",
    count: result.replacementCount,
  });
  statusLog.pushStatus(message);
  toast.success(message);
}
