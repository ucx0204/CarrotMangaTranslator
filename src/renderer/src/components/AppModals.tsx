import React from "react";
import type {
  AppSettings,
  ImportPreviewResult,
  LibraryIndex,
  WorkShareExportRequest,
  WorkShareImportPreview
} from "../../../shared/types";
import { ConfirmModal } from "./ConfirmModal";
import { InpaintingGuideModal } from "./InpaintingGuideModal";
import { ImportModal, type ImportModalSubmit } from "./ImportModal";
import { RenameModal } from "./RenameModal";
import { SettingsModal } from "./SettingsModal";
import { ShareExportModal } from "./ShareExportModal";
import { ShareImportModal, type ShareImportModalSubmit } from "./ShareImportModal";
import { TranslateSourceModal, type TranslateSourceMode } from "./TranslateSourceModal";
import type { ConfirmDialogState } from "../hooks/useConfirmDialog";

type RenameTarget =
  | {
      kind: "work";
      id: string;
      title: string;
    }
  | {
      kind: "chapter";
      id: string;
      title: string;
    };

type AppModalsProps = {
  library: LibraryIndex;
  currentWorkId: string | null;
  translationSourceOpen: boolean;
  importPreview: ImportPreviewResult | null;
  importBusy: boolean;
  shareExportOpen: boolean;
  shareExportBusy: boolean;
  shareImportPreview: WorkShareImportPreview | null;
  shareImportBusy: boolean;
  renameTarget: RenameTarget | null;
  renameBusy: boolean;
  settingsOpen: boolean;
  settings: AppSettings | null;
  settingsBusy: boolean;
  jobActive: boolean;
  confirmDialog: ConfirmDialogState | null;
  inpaintingGuideOpen: boolean;
  onCancelTranslationSource: () => void;
  onSelectTranslationSource: (mode: TranslateSourceMode) => void;
  onCancelImport: () => void;
  onSubmitImport: (payload: ImportModalSubmit) => void;
  onCancelShareExport: () => void;
  onSubmitShareExport: (request: WorkShareExportRequest) => void;
  onCancelShareImport: () => void;
  onSubmitShareImport: (payload: ShareImportModalSubmit) => void;
  onCancelRename: () => void;
  onDeleteRename: () => void;
  onSubmitRename: (title: string) => void;
  onCancelSettings: () => void;
  onOpenLogFolder: () => void;
  onResetSettings: () => void;
  onSubmitSettings: (settings: AppSettings) => void;
  onResolveConfirm: (confirmed: boolean) => void;
  onCloseInpaintingGuide: (hideNextTime: boolean) => void;
};

export function AppModals({
  library,
  currentWorkId,
  translationSourceOpen,
  importPreview,
  importBusy,
  shareExportOpen,
  shareExportBusy,
  shareImportPreview,
  shareImportBusy,
  renameTarget,
  renameBusy,
  settingsOpen,
  settings,
  settingsBusy,
  jobActive,
  confirmDialog,
  inpaintingGuideOpen,
  onCancelTranslationSource,
  onSelectTranslationSource,
  onCancelImport,
  onSubmitImport,
  onCancelShareExport,
  onSubmitShareExport,
  onCancelShareImport,
  onSubmitShareImport,
  onCancelRename,
  onDeleteRename,
  onSubmitRename,
  onCancelSettings,
  onOpenLogFolder,
  onResetSettings,
  onSubmitSettings,
  onResolveConfirm,
  onCloseInpaintingGuide
}: AppModalsProps): React.JSX.Element {
  return (
    <>
      {translationSourceOpen ? <TranslateSourceModal busy={importBusy} onCancel={onCancelTranslationSource} onSelect={onSelectTranslationSource} /> : null}

      {importPreview ? <ImportModal library={library} preview={importPreview} busy={importBusy} onCancel={onCancelImport} onSubmit={onSubmitImport} /> : null}

      {shareExportOpen ? (
        <ShareExportModal
          library={library}
          currentWorkId={currentWorkId}
          busy={shareExportBusy}
          onCancel={onCancelShareExport}
          onSubmit={onSubmitShareExport}
        />
      ) : null}

      {shareImportPreview ? (
        <ShareImportModal
          library={library}
          preview={shareImportPreview}
          busy={shareImportBusy}
          onCancel={onCancelShareImport}
          onSubmit={onSubmitShareImport}
        />
      ) : null}

      {renameTarget ? (
        <RenameModal
          kind={renameTarget.kind}
          initialTitle={renameTarget.title}
          busy={renameBusy}
          onCancel={onCancelRename}
          onDelete={onDeleteRename}
          onSubmit={onSubmitRename}
        />
      ) : null}

      {settingsOpen && settings ? (
        <SettingsModal
          initialSettings={settings}
          busy={settingsBusy}
          jobActive={jobActive}
          onCancel={onCancelSettings}
          onOpenLogFolder={onOpenLogFolder}
          onReset={onResetSettings}
          onSubmit={onSubmitSettings}
        />
      ) : null}

      {confirmDialog ? (
        <ConfirmModal
          title={confirmDialog.title}
          message={confirmDialog.message}
          detail={confirmDialog.detail}
          onConfirm={() => onResolveConfirm(true)}
          onCancel={() => onResolveConfirm(false)}
        />
      ) : null}

      {inpaintingGuideOpen ? <InpaintingGuideModal onClose={onCloseInpaintingGuide} /> : null}
    </>
  );
}

export type { RenameTarget };
