import { useConfirmDialog } from "../../hooks/useConfirmDialog";
import { useImportShareModalController } from "../../hooks/useImportShareModalController";
import { useSettingsDialog } from "../../hooks/useSettingsDialog";
import type { useStatusLog } from "../../hooks/useStatusLog";
import type { useAppSessionUiState } from "./useAppSessionUiState";
import { useInpaintingGuidePreference } from "./useInpaintingGuidePreference";

type UseModalControllerArgs = {
  pushStatus: ReturnType<typeof useStatusLog>["pushStatus"];
  uiState: ReturnType<typeof useAppSessionUiState>;
};

export function useModalController({
  pushStatus,
  uiState,
}: UseModalControllerArgs) {
  const importShareModal = useImportShareModalController();
  const confirmController = useConfirmDialog();
  const settingsDialog = useSettingsDialog(pushStatus);
  const guidePreference = useInpaintingGuidePreference({
    saveSettingsQuietly: settingsDialog.saveSettingsQuietly,
    setInpaintingGuideOpen: uiState.setInpaintingGuideOpen,
    settings: settingsDialog.settings,
  });

  return {
    confirmController,
    guidePreference,
    importShareModal,
    settingsDialog,
  };
}
