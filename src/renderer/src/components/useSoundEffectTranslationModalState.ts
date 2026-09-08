import React from "react";
import type {
  PrepareSoundEffectTranslationRequest,
  RestoreSoundEffectReviewRequest,
} from "../../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import {
  updateDraftRegion,
  type SelectedSoundEffectDraftRegion,
  type SoundEffectDraftPage,
} from "./soundEffectTranslationDraftModel";
import {
  buildPrepareRequest,
  createSoundEffectDraftPages,
} from "./soundEffectTranslationDraft";
import { useSoundEffectReviewReset } from "./useSoundEffectReviewReset";

type SoundEffectTranslationModalStateInput = {
  chapter: ChapterSnapshot;
  jobActive: boolean;
  autoFontMatchingDefault: boolean;
  inpaintAfterTranslationDefault: boolean;
  onClose: () => void;
  onRestore?: (
    request: RestoreSoundEffectReviewRequest,
  ) => Promise<ChapterSnapshot>;
  onPersistDefaults?: (patch: {
    sfxAutoFontMatchingDefault: boolean;
    sfxInpaintAfterTranslationDefault: boolean;
  }) => void;
  onStart: (
    request: PrepareSoundEffectTranslationRequest,
    inpaintAfterTranslation: boolean,
    autoFontMatching: boolean,
  ) => void | Promise<void>;
};

export function useSoundEffectTranslationModalState(
  input: SoundEffectTranslationModalStateInput,
) {
  const draft = useSoundEffectDraft(input.chapter);
  const {
    draftPages,
    setDraftPages,
    selectedRegion,
    setSelectedRegion,
    prepareRequest,
  } = draft;
  const [inpaintAfterTranslation, setInpaintAfterTranslation] = React.useState(
    input.inpaintAfterTranslationDefault,
  );
  const [autoFontMatching, setAutoFontMatching] = React.useState(
    input.autoFontMatchingDefault,
  );
  const [saveDefaults, setSaveDefaults] = React.useState(false);
  const resetReview = useSoundEffectReviewReset({
    chapter: input.chapter,
    draftPages,
    setDraftPages,
    jobActive: input.jobActive,
    onRestore: input.onRestore,
  });
  useDeleteSelectedRegionOnKeyboard({
    jobActive: input.jobActive || resetReview.busy,
    onClose: input.onClose,
    selectedRegion,
    setDraftPages,
    setSelectedRegion,
  });
  const start = React.useCallback(() => {
    if (
      input.jobActive ||
      resetReview.busy ||
      prepareRequest.pages.length === 0
    )
      return;
    if (saveDefaults) {
      input.onPersistDefaults?.({
        sfxAutoFontMatchingDefault: autoFontMatching,
        sfxInpaintAfterTranslationDefault: inpaintAfterTranslation,
      });
    }
    handoffActiveModalToWorkCenter();
    input.onClose();
    void input.onStart(
      prepareRequest,
      inpaintAfterTranslation,
      autoFontMatching,
    );
  }, [
    autoFontMatching,
    inpaintAfterTranslation,
    input,
    prepareRequest,
    saveDefaults,
    resetReview.busy,
  ]);
  const includedCount = prepareRequest.pages.reduce(
    (count, page) => count + page.includedRegionIds.length,
    0,
  );
  return {
    ...draft,
    autoFontMatching,
    includedCount,
    inpaintAfterTranslation,
    resetReview,
    saveDefaults,
    setAutoFontMatching,
    setInpaintAfterTranslation,
    setSaveDefaults,
    start,
  };
}

function useSoundEffectDraft(chapter: ChapterSnapshot) {
  const [draftPages, setDraftPages] = React.useState<SoundEffectDraftPage[]>(
    () => createSoundEffectDraftPages(chapter),
  );
  const [selectedRegion, setSelectedRegion] =
    React.useState<SelectedSoundEffectDraftRegion>(null);
  const [showAllPages, setShowAllPages] = React.useState(false);
  const [showTranslations, setShowTranslations] = React.useState(false);
  const prepareRequest = React.useMemo(
    () => buildPrepareRequest(chapter.id, draftPages),
    [draftPages, chapter.id],
  );
  React.useEffect(() => {
    if (
      !draftPages.some((item) => item.regions.some((region) => !region.deleted))
    )
      setShowAllPages(true);
  }, [draftPages]);
  return {
    draftPages,
    setDraftPages,
    selectedRegion,
    setSelectedRegion,
    showAllPages,
    setShowAllPages,
    showTranslations,
    setShowTranslations,
    prepareRequest,
  };
}

function useDeleteSelectedRegionOnKeyboard({
  jobActive,
  onClose,
  selectedRegion,
  setDraftPages,
  setSelectedRegion,
}: {
  jobActive: boolean;
  onClose: () => void;
  selectedRegion: SelectedSoundEffectDraftRegion;
  setDraftPages: React.Dispatch<React.SetStateAction<SoundEffectDraftPage[]>>;
  setSelectedRegion: (selection: SelectedSoundEffectDraftRegion) => void;
}): void {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (jobActive) return;
      const deletesSelection =
        event.key === "Escape" ||
        event.key === "Delete" ||
        event.key === "Backspace";
      if (!deletesSelection) return;
      if (event.key !== "Escape" && isEditableKeyboardTarget(event.target)) {
        return;
      }
      if (!selectedRegion) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      setDraftPages((current) =>
        updateDraftRegion(
          current,
          selectedRegion.pageId,
          selectedRegion.regionId,
          (region) => ({ ...region, deleted: true }),
        ),
      );
      setSelectedRegion(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [jobActive, onClose, selectedRegion, setDraftPages, setSelectedRegion]);
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
