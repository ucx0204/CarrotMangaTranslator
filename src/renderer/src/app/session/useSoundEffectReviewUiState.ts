import { useCallback, useMemo, useState } from "react";

export function useSoundEffectReviewUiState() {
  const [soundEffectReviewVisible, setSoundEffectReviewVisible] =
    useState(false);
  const [soundEffectTranslationOpen, setSoundEffectTranslationOpen] =
    useState(false);
  const [
    selectedSoundEffectReviewRegionId,
    setSelectedSoundEffectReviewRegionId,
  ] = useState<string | null>(null);
  const resetSoundEffectReviewUi = useCallback(() => {
    setSoundEffectReviewVisible(false);
    setSoundEffectTranslationOpen(false);
    setSelectedSoundEffectReviewRegionId(null);
  }, []);
  return useMemo(
    () => ({
      resetSoundEffectReviewUi,
      selectedSoundEffectReviewRegionId,
      setSelectedSoundEffectReviewRegionId,
      setSoundEffectReviewVisible,
      setSoundEffectTranslationOpen,
      soundEffectReviewVisible,
      soundEffectTranslationOpen,
    }),
    [
      resetSoundEffectReviewUi,
      selectedSoundEffectReviewRegionId,
      soundEffectReviewVisible,
      soundEffectTranslationOpen,
    ],
  );
}
