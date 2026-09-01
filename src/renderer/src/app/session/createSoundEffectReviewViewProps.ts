import { createSoundEffectReviewPageRevision } from "../../../../shared/pageRevision";
import type { SoundEffectTranslationLauncherProps } from "../../components/SoundEffectTranslationLauncher";
import type { SoundEffectTranslationModalProps } from "../../components/SoundEffectTranslationModal";
import { summarizeSoundEffectReviewChapter } from "../../lib/soundEffectReviewRegions";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { createPersistUiDefaults } from "./createTranslationModalProps";

export function createSoundEffectTranslationLauncherProps({
  core,
  derivedState,
  uiState,
}: Pick<
  AppSessionViewModel,
  "core" | "derivedState" | "uiState"
>): SoundEffectTranslationLauncherProps {
  const chapter = core.currentChapter;
  const summary = summarizeSoundEffectReviewChapter(chapter?.pages ?? []);
  return {
    active: uiState.soundEffectTranslationOpen,
    available: summary.pendingCount > 0,
    disabled: derivedState.jobActive,
    pendingCount: summary.pendingCount,
    onOpen: () => {
      uiState.setSelectedSoundEffectReviewRegionId(null);
      uiState.setSoundEffectReviewVisible(false);
      uiState.setSoundEffectTranslationOpen(true);
    },
  };
}

type WorkspaceReviewProps = Pick<
  AppSessionViewProps["workspaceProps"],
  | "onExitSoundEffectReview"
  | "onDismissSoundEffectReviewRegion"
  | "onOpenSoundEffectTranslation"
  | "onSelectSoundEffectReviewRegion"
  | "onTranslateSoundEffectReviewRegion"
  | "selectedSoundEffectReviewRegionId"
  | "showSoundEffectReview"
>;

export function createWorkspaceSoundEffectReviewProps({
  derivedState,
  libraryActions,
  settingsDialog,
  translationActions,
  uiState,
}: Pick<
  AppSessionViewModel,
  | "derivedState"
  | "libraryActions"
  | "settingsDialog"
  | "translationActions"
  | "uiState"
>): WorkspaceReviewProps {
  const selectedPage = derivedState.selectedPage;
  const closeReview = (): void => {
    uiState.setSelectedSoundEffectReviewRegionId(null);
    uiState.setSoundEffectReviewVisible(false);
  };
  return {
    showSoundEffectReview: Boolean(
      selectedPage && uiState.soundEffectReviewVisible,
    ),
    selectedSoundEffectReviewRegionId:
      uiState.selectedSoundEffectReviewRegionId,
    onSelectSoundEffectReviewRegion:
      uiState.setSelectedSoundEffectReviewRegionId,
    onDismissSoundEffectReviewRegion: async (regionId) => {
      if (!selectedPage) return;
      await libraryActions.dismissSoundEffectReviewRegion(
        selectedPage.id,
        regionId,
      );
      uiState.setSelectedSoundEffectReviewRegionId(null);
    },
    onExitSoundEffectReview: closeReview,
    onOpenSoundEffectTranslation: () => {
      closeReview();
      uiState.setSoundEffectTranslationOpen(true);
    },
    onTranslateSoundEffectReviewRegion: (region) => {
      if (!selectedPage) return;
      const target = {
        pageId: selectedPage.id,
        pageRevision: createSoundEffectReviewPageRevision(selectedPage),
        regionIds: [region.id],
      };
      closeReview();
      void translationActions.translateSoundEffects(
        [target],
        settingsDialog.settings?.ui?.sfxInpaintAfterTranslationDefault ?? false,
        settingsDialog.settings?.ui?.sfxAutoFontMatchingDefault ?? false,
      );
    },
  };
}

export function createSoundEffectTranslationModalProps({
  core,
  derivedState,
  settingsDialog,
  translationActions,
  uiState,
}: Pick<
  AppSessionViewModel,
  "core" | "derivedState" | "settingsDialog" | "translationActions" | "uiState"
>): SoundEffectTranslationModalProps | null {
  const chapter = core.currentChapter;
  if (!chapter || !uiState.soundEffectTranslationOpen) return null;
  return {
    chapter,
    jobActive: derivedState.jobActive,
    autoFontMatchingDefault:
      settingsDialog.settings?.ui?.sfxAutoFontMatchingDefault ?? false,
    inpaintAfterTranslationDefault:
      settingsDialog.settings?.ui?.sfxInpaintAfterTranslationDefault ?? false,
    onPersistDefaults: createPersistUiDefaults(settingsDialog),
    onClose: () => uiState.setSoundEffectTranslationOpen(false),
    onStart: (request, inpaintAfterTranslation, autoFontMatching) => {
      uiState.setSoundEffectTranslationOpen(false);
      uiState.setSelectedSoundEffectReviewRegionId(null);
      uiState.setSoundEffectReviewVisible(false);
      void translationActions.translateSoundEffects(
        [],
        inpaintAfterTranslation,
        autoFontMatching,
        request,
      );
    },
  };
}
