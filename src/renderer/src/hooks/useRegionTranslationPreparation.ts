import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { mangaGateway } from "../api/mangaGateway";

type UseRegionTranslationPreparationOptions = {
  inpaintingMode: boolean;
  pushStatus: (line: string) => void;
};

export function useRegionTranslationPreparation({
  inpaintingMode,
  pushStatus,
}: UseRegionTranslationPreparationOptions): () => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(async () => {
    if (!inpaintingMode) {
      return;
    }
    pushStatus(t("regionTranslation.disposeInpainting"));
    await mangaGateway.disposeInpaintingEngine();
  }, [inpaintingMode, pushStatus, t]);
}
