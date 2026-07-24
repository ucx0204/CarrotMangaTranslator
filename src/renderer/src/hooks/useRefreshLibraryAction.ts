import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { formatErrorMessage } from "../lib/errorPresentation";
import { libraryGateway } from "../api/libraryGateway";
import type { UseLibraryActionsOptions } from "./libraryActionTypes";

type RefreshLibraryOptions = Pick<
  UseLibraryActionsOptions,
  "pushStatus" | "setLibrary"
>;

export function useRefreshLibraryAction({
  pushStatus,
  setLibrary,
}: RefreshLibraryOptions): () => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(async () => {
    try {
      setLibrary(await libraryGateway.getLibrary());
    } catch (error) {
      console.error(error);
      pushStatus(formatErrorMessage(error, t("library.refreshFailed")));
    }
  }, [pushStatus, setLibrary, t]);
}
