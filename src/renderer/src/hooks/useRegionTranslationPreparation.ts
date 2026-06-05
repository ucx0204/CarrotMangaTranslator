import { useCallback } from "react";

type UseRegionTranslationPreparationOptions = {
  inpaintingMode: boolean;
  pushStatus: (line: string) => void;
};

export function useRegionTranslationPreparation({
  inpaintingMode,
  pushStatus
}: UseRegionTranslationPreparationOptions): () => Promise<void> {
  return useCallback(async () => {
    if (!inpaintingMode) {
      return;
    }
    pushStatus("영역 번역을 위해 Flux 인페인팅 런타임을 정리합니다.");
    await window.mangaApi.disposeInpaintingEngine();
  }, [inpaintingMode, pushStatus]);
}
