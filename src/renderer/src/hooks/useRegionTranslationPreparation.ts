import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { mangaGateway } from "../api/mangaGateway";

type UseRegionTranslationPreparationOptions = {
  pushStatus: (line: string) => void;
};

export function useRegionTranslationPreparation({
  pushStatus,
}: UseRegionTranslationPreparationOptions): () => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(async () => {
    pushStatus(t("regionTranslation.disposeInpainting"));
    await mangaGateway.disposeInpaintingEngine();
  }, [pushStatus, t]);
}
