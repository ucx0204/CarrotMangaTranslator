import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { analysisGateway } from "../../api/analysisGateway";
import { appGateway } from "../../api/appGateway";
import { formatErrorMessage } from "../../lib/errorPresentation";

export function useAppSessionBridgeActions(
  pushStatus: (line: string) => void,
): {
  cancelJob: () => void;
  openLibraryFolder: () => void;
  openLogFolder: () => void;
} {
  const { t } = useTranslation("renderer");
  const cancelJob = useCallback(() => {
    void analysisGateway.cancelJob().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, t("bridge.cancelJobFailed")));
    });
  }, [pushStatus, t]);

  const openLibraryFolder = useCallback(() => {
    void appGateway.openLibraryFolder().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, t("bridge.openLibraryFailed")));
    });
  }, [pushStatus, t]);

  const openLogFolder = useCallback(() => {
    void appGateway.openLogFolder().catch((error) => {
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
