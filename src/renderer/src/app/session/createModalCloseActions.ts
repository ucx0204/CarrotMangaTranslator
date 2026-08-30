import type { AppSessionViewModel } from "./appSessionViewModel";

export function createModalCloseActions({
  guidePreference,
  importShareActions,
  importShareModal,
  libraryActions,
  settingsDialog,
}: Pick<
  AppSessionViewModel,
  | "guidePreference"
  | "importShareActions"
  | "importShareModal"
  | "libraryActions"
  | "settingsDialog"
>) {
  return {
    onCancelImport: () => void importShareActions.cancelImportPreview(),
    onCancelWebImport: () => {
      importShareModal.setWebImportBackgrounded(false);
      importShareModal.setWebImportOpen(false);
    },
    onCancelRename: () => {
      if (!libraryActions.renameBusy) libraryActions.setRenameTarget(null);
    },
    onCancelSettings: settingsDialog.closeSettings,
    onCancelShareExport: () => {
      if (importShareModal.shareExportBusy) return;
      importShareModal.setShareExportDraft(null);
      importShareModal.setShareExportOpen(false);
    },
    onCancelShareImport: () => {
      if (importShareModal.shareImportBusy) return;
      importShareModal.setShareImportDraft(null);
      importShareModal.setShareImportPreview(null);
    },
    onCancelTranslationSource: () =>
      importShareModal.setTranslationSourceOpen(false),
    onCloseInpaintingGuide: guidePreference.closeInpaintingGuide,
  };
}
