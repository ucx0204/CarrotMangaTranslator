import React from "react";
import type { PrepareSoundEffectTranslationRequest } from "../../../shared/analysisTypes";
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

type SoundEffectTranslationModalStateInput = {
  chapter: ChapterSnapshot;
  jobActive: boolean;
  autoFontMatchingDefault: boolean;
  inpaintAfterTranslationDefault: boolean;
  onClose: () => void;
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
  const [draftPages, setDraftPages] = React.useState<SoundEffectDraftPage[]>(
    () => createSoundEffectDraftPages(input.chapter),
  );
  const [selectedRegion, setSelectedRegion] =
    React.useState<SelectedSoundEffectDraftRegion>(null);
  const [showAllPages, setShowAllPages] = React.useState(false);
  const [showTranslations, setShowTranslations] = React.useState(false);
  const [inpaintAfterTranslation, setInpaintAfterTranslation] = React.useState(
    input.inpaintAfterTranslationDefault,
  );
  const [autoFontMatching, setAutoFontMatching] = React.useState(
    input.autoFontMatchingDefault,
  );
  const [saveDefaults, setSaveDefaults] = React.useState(false);
  const prepareRequest = React.useMemo(
    () => buildPrepareRequest(input.chapter.id, draftPages),
    [draftPages, input.chapter.id],
  );
  useDeleteSelectedRegionOnKeyboard({
    jobActive: input.jobActive,
    onClose: input.onClose,
    selectedRegion,
    setDraftPages,
    setSelectedRegion,
  });
  const start = React.useCallback(() => {
    if (input.jobActive || prepareRequest.pages.length === 0) return;
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
  ]);
  const includedCount = prepareRequest.pages.reduce(
    (count, page) => count + page.includedRegionIds.length,
    0,
  );
  return {
    autoFontMatching,
    draftPages,
    includedCount,
    inpaintAfterTranslation,
    prepareRequest,
    saveDefaults,
    selectedRegion,
    setAutoFontMatching,
    setDraftPages,
    setInpaintAfterTranslation,
    setSaveDefaults,
    setSelectedRegion,
    setShowAllPages,
    setShowTranslations,
    showAllPages,
    showTranslations,
    start,
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
