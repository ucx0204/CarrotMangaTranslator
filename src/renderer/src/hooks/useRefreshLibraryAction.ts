import { useCallback } from "react";
import { formatErrorMessage } from "../lib/appHelpers";
import { libraryGateway } from "./libraryGateway";
import type { UseLibraryActionsOptions } from "./libraryActionTypes";

type RefreshLibraryOptions = Pick<
  UseLibraryActionsOptions,
  "pushStatus" | "setLibrary"
>;

export function useRefreshLibraryAction({
  pushStatus,
  setLibrary,
}: RefreshLibraryOptions): () => Promise<void> {
  return useCallback(async () => {
    try {
      setLibrary(await libraryGateway.getLibrary());
    } catch (error) {
      console.error(error);
      pushStatus(
        formatErrorMessage(error, "보관함 목록을 불러오지 못했습니다."),
      );
    }
  }, [pushStatus, setLibrary]);
}
