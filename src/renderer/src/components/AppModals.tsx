import React from "react";
import type {
  ImportPreviewResult,
  ImportPreviewSession,
} from "../../../shared/importTypes";
import type { LibraryIndex } from "../../../shared/libraryTypes";
import type { AppSettings } from "../../../shared/settingsTypes";
import type {
  WorkShareExportRequest,
  WorkShareImportPreview,
} from "../../../shared/shareTypes";
import type {
  ImportModalSubmit,
  TranslateSourceMode,
} from "../lib/importFlowTypes";
import type { RenameTarget } from "../lib/libraryRenameTypes";
import type { ShareImportModalSubmit } from "../lib/shareImportTypes";
import { ConfirmModal } from "./ConfirmModal";
import { InpaintingGuideModal } from "./InpaintingGuideModal";
import { ImportModal } from "./ImportModal";
import { RenameModal } from "./RenameModal";
import { SettingsModal } from "./SettingsModal";
import { ShareExportModal } from "./ShareExportModal";
import { ShareImportModal } from "./ShareImportModal";
import { TranslateSourceModal } from "./TranslateSourceModal";
import { WebImportModal } from "./WebImportModal";
import { FontManagerModal } from "./FontManagerModal";
import type { ConfirmDialogState } from "../hooks/useConfirmDialog";
import type { ImportModalFeedback } from "../lib/importFlowTypes";

type AppModalsProps = {
  library: LibraryIndex;
  currentWorkId: string | null;
  translationSourceOpen: boolean;
  webImportOpen: boolean;
  importPreview: ImportPreviewResult | null;
  importBusy: boolean;
  importDraft: ImportModalSubmit | null;
  importFeedback: ImportModalFeedback | null;
  shareExportOpen: boolean;
  shareExportDraft: WorkShareExportRequest | null;
  shareExportBusy: boolean;
  shareImportPreview: WorkShareImportPreview | null;
  shareImportDraft: ShareImportModalSubmit | null;
  shareImportBusy: boolean;
  renameTarget: RenameTarget | null;
  renameBusy: boolean;
  settingsOpen: boolean;
  settingsOpenRequest: React.ComponentProps<
    typeof SettingsModal
  >["openRequest"];
  settings: AppSettings | null;
  settingsBusy: boolean;
  jobActive: boolean;
  confirmDialog: ConfirmDialogState | null;
  inpaintingGuideOpen: boolean;
  fontManagerOpen: boolean;
  onCancelTranslationSource: () => void;
  onCancelWebImport: () => void;
  onWebImportBackgroundStateChange: (backgrounded: boolean) => void;
  onPreparedWebImport: (preview: ImportPreviewSession) => void;
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
  onOpenErrorReport: () => void;
  onOpenLogFolder: () => void;
  onResetSettings: () => Promise<AppSettings | null>;
  onSubmitSettings: (settings: AppSettings) => void;
  onResolveConfirm: (confirmed: boolean) => void;
  onCloseInpaintingGuide: (hideNextTime: boolean) => void;
  onCloseFontManager: () => void;
};

export function AppModals(props: AppModalsProps): React.JSX.Element {
  return (
    <>
      <ImportFlowModals {...props} />
      <ShareFlowModals {...props} />
      <EditAndSettingsModals {...props} />
      <SystemModals {...props} />
    </>
  );
}

function ImportFlowModals({
  currentWorkId,
  importBusy,
  importDraft,
  importFeedback,
  importPreview,
  library,
  onCancelImport,
  onCancelTranslationSource,
  onCancelWebImport,
  onWebImportBackgroundStateChange,
  onPreparedWebImport,
  onSelectTranslationSource,
  onSubmitImport,
  translationSourceOpen,
  webImportOpen,
}: Pick<
  AppModalsProps,
  | "importBusy"
  | "importDraft"
  | "importFeedback"
  | "importPreview"
  | "library"
  | "currentWorkId"
  | "onCancelImport"
  | "onCancelTranslationSource"
  | "onCancelWebImport"
  | "onWebImportBackgroundStateChange"
  | "onPreparedWebImport"
  | "onSelectTranslationSource"
  | "onSubmitImport"
  | "translationSourceOpen"
  | "webImportOpen"
>): React.JSX.Element {
  return (
    <>
      {translationSourceOpen ? (
        <TranslateSourceModal
          busy={importBusy}
          onCancel={onCancelTranslationSource}
          onSelect={onSelectTranslationSource}
        />
      ) : null}
      {webImportOpen ? (
        <WebImportModal
          onCancel={onCancelWebImport}
          onBackgroundStateChange={onWebImportBackgroundStateChange}
          onPrepared={onPreparedWebImport}
        />
      ) : null}
      {importPreview ? (
        <ImportModal
          library={library}
          currentWorkId={currentWorkId}
          preview={importPreview}
          busy={importBusy}
          initialDraft={importDraft}
          feedback={importFeedback}
          onCancel={onCancelImport}
          onSubmit={onSubmitImport}
        />
      ) : null}
    </>
  );
}

function ShareFlowModals({
  currentWorkId,
  library,
  onCancelShareExport,
  onCancelShareImport,
  onSubmitShareExport,
  onSubmitShareImport,
  shareExportBusy,
  shareExportOpen,
  shareExportDraft,
  shareImportBusy,
  shareImportPreview,
  shareImportDraft,
}: Pick<
  AppModalsProps,
  | "currentWorkId"
  | "library"
  | "onCancelShareExport"
  | "onCancelShareImport"
  | "onSubmitShareExport"
  | "onSubmitShareImport"
  | "shareExportBusy"
  | "shareExportOpen"
  | "shareExportDraft"
  | "shareImportBusy"
  | "shareImportPreview"
  | "shareImportDraft"
>): React.JSX.Element {
  return (
    <>
      {shareExportOpen ? (
        <ShareExportModal
          library={library}
          currentWorkId={currentWorkId}
          initialRequest={shareExportDraft}
          busy={shareExportBusy}
          onCancel={onCancelShareExport}
          onSubmit={onSubmitShareExport}
        />
      ) : null}
      {shareImportPreview ? (
        <ShareImportModal
          library={library}
          preview={shareImportPreview}
          initialDraft={shareImportDraft}
          busy={shareImportBusy}
          onCancel={onCancelShareImport}
          onSubmit={onSubmitShareImport}
        />
      ) : null}
    </>
  );
}

function EditAndSettingsModals({
  library,
  jobActive,
  onCancelRename,
  onCancelSettings,
  onDeleteRename,
  onOpenErrorReport,
  onOpenLogFolder,
  onResetSettings,
  onSubmitRename,
  onSubmitSettings,
  renameBusy,
  renameTarget,
  settings,
  settingsBusy,
  settingsOpen,
  settingsOpenRequest,
}: Pick<
  AppModalsProps,
  | "jobActive"
  | "library"
  | "onCancelRename"
  | "onCancelSettings"
  | "onDeleteRename"
  | "onOpenErrorReport"
  | "onOpenLogFolder"
  | "onResetSettings"
  | "onSubmitRename"
  | "onSubmitSettings"
  | "renameBusy"
  | "renameTarget"
  | "settings"
  | "settingsBusy"
  | "settingsOpen"
  | "settingsOpenRequest"
>): React.JSX.Element {
  return (
    <>
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
          openRequest={settingsOpenRequest}
          library={library}
          busy={settingsBusy}
          jobActive={jobActive}
          onCancel={onCancelSettings}
          onOpenErrorReport={onOpenErrorReport}
          onOpenLogFolder={onOpenLogFolder}
          onReset={onResetSettings}
          onSubmit={onSubmitSettings}
        />
      ) : null}
    </>
  );
}

function SystemModals({
  confirmDialog,
  fontManagerOpen,
  onCloseFontManager,
  inpaintingGuideOpen,
  onCloseInpaintingGuide,
  onResolveConfirm,
}: Pick<
  AppModalsProps,
  | "confirmDialog"
  | "fontManagerOpen"
  | "onCloseFontManager"
  | "inpaintingGuideOpen"
  | "onCloseInpaintingGuide"
  | "onResolveConfirm"
>): React.JSX.Element {
  return (
    <>
      {fontManagerOpen ? (
        <FontManagerModal onClose={onCloseFontManager} />
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
      {inpaintingGuideOpen ? (
        <InpaintingGuideModal onClose={onCloseInpaintingGuide} />
      ) : null}
    </>
  );
}
