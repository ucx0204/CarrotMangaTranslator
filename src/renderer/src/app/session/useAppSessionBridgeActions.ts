import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { mangaGateway } from "../../api/mangaGateway";
import { formatErrorMessage } from "../../lib/appHelpers";

export function useAppSessionBridgeActions(
  pushStatus: (line: string) => void,
): {
  cancelJob: () => void;
  openLibraryFolder: () => void;
  openLogFolder: () => void;
} {
  const { t } = useTranslation("renderer");
  const cancelJob = useCallback(() => {
    void mangaGateway.cancelJob().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, t("bridge.cancelJobFailed")));
    });
  }, [pushStatus, t]);

  const openLibraryFolder = useCallback(() => {
    void mangaGateway.openLibraryFolder().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, t("bridge.openLibraryFailed")));
    });
  }, [pushStatus, t]);

  const openLogFolder = useCallback(() => {
    void mangaGateway.openLogFolder().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, t("bridge.openLogsFailed")));
    });
  }, [pushStatus, t]);

  return {
    cancelJob,
    openLibraryFolder,
    openLogFolder,
  };
}
