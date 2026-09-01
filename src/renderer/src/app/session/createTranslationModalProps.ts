import type { UiSettings } from "../../../../shared/settingsTypes";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";

export function createTranslationOptionsProps({
  core,
  settingsDialog,
  translationActions,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["translationOptionsProps"] {
  return uiState.translateOptionsOpen && core.currentChapter
    ? {
        chapter: core.currentChapter,
        currentPageId: core.selectedPageId,
        initialScope: uiState.translateOptionsInitialScope,
        library: core.library,
        onClose: uiState.closeTranslateOptions,
        onPersistDefaults: createPersistUiDefaults(settingsDialog),
        onStart: (flowOptions) =>
          void translationActions.runTranslationFlow(flowOptions),
        sourceLanguage: settingsDialog.settings?.translation?.sourceLanguage,
        targetLanguage: settingsDialog.settings?.translation?.targetLanguage,
        uiSettings: settingsDialog.settings?.ui,
      }
    : null;
}

export function createPageRetranslateProps({
  core,
  settingsDialog,
  translationActions,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["pageRetranslateProps"] {
  const pageId = uiState.retranslatePageId;
  const page = pageId
    ? core.currentChapter?.pages.find((candidate) => candidate.id === pageId)
    : undefined;
  return pageId && page
    ? {
        blockCount: page.blocks.length,
        onClose: () => uiState.setRetranslatePageId(null),
        onPersistDefaults: createPersistUiDefaults(settingsDialog),
        onStart: (
          blockMode,
          naturalTextLayout,
          autoFontMatching,
          aiFontSizeMatching,
        ) =>
          void translationActions.runAnalysis(
            "single-page",
            pageId,
            undefined,
            blockMode,
            undefined,
            naturalTextLayout,
            autoFontMatching,
            aiFontSizeMatching,
          ),
        pageName: page.name,
        uiSettings: settingsDialog.settings?.ui,
      }
    : null;
}

export function createPersistUiDefaults(
  settingsDialog: AppSessionViewModel["settingsDialog"],
): (patch: Partial<UiSettings>) => void {
  return (patch) => {
    if (settingsDialog.settings) {
      void settingsDialog.saveSettingsQuietly({
        ...settingsDialog.settings,
        ui: { ...settingsDialog.settings.ui, ...patch },
      });
    }
  };
}
