import { useCallback } from "react";
import { mangaGateway } from "../../api/mangaGateway";
import { formatErrorMessage } from "../../lib/appHelpers";

export function useAppSessionBridgeActions(
  pushStatus: (line: string) => void,
): {
  cancelJob: () => void;
  openLibraryFolder: () => void;
  openLogFolder: () => void;
} {
  const cancelJob = useCallback(() => {
    void mangaGateway.cancelJob().catch((error) => {
      console.error(error);
      pushStatus(
        formatErrorMessage(error, "작업 취소 요청을 보내지 못했습니다."),
      );
    });
  }, [pushStatus]);

  const openLibraryFolder = useCallback(() => {
    void mangaGateway.openLibraryFolder().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, "보관함 폴더를 열지 못했습니다."));
    });
  }, [pushStatus]);

  const openLogFolder = useCallback(() => {
    void mangaGateway.openLogFolder().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, "로그 폴더를 열지 못했습니다."));
    });
  }, [pushStatus]);

  return {
    cancelJob,
    openLibraryFolder,
    openLogFolder,
  };
}
