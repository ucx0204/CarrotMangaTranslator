import { PageEditorModal } from "./PageEditorModal";
import React from "react";
import type {
  ImportPreviewResult,
  ImportPreviewSession,
} from "../../../shared/importTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
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
import { LibraryEditModals } from "./LibraryEditModals";
import { SettingsModal } from "./SettingsModal";
import { ShareExportModal } from "./ShareExportModal";
import { ShareImportModal } from "./ShareImportModal";
import { TranslateSourceModal } from "./TranslateSourceModal";
import { WebImportModal } from "./WebImportModal";
import { FontManagerModal } from "./FontManagerModal";
import type { ConfirmDialogState } from "../hooks/useConfirmDialog";
import type { ImportModalFeedback } from "../lib/importFlowTypes";

type AppModalsProps = {
  pageEditor?: React.ComponentProps<typeof PageEditorModal> | null;
  addPagesChapter?: ChapterSnapshot | null;
  onClearAddPages?: () => void;
  library: LibraryIndex;
  currentWorkId: string | null;
  currentChapterId?: string | null;
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
  settingsRecovery?: React.ComponentProps<typeof SettingsModal>["recovery"];
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
  onSubmitRename: (title: string, moveResultFolders: boolean) => void;
  onCancelSettings: () => void;
  onOpenErrorReport: () => void;
  onOpenLogFolder: () => void;
  onOpenModelFolder: () => void;
  onResetSettings: () => Promise<AppSettings | null>;
  onSubmitSettings: (settings: AppSettings) => void;
  onResolveConfirm: (confirmed: boolean) => void;
  onCloseInpaintingGuide: (hideNextTime: boolean) => void;
  onCloseFontManager: () => void;
};

export function AppModals(props: AppModalsProps): React.JSX.Element {
  return (
    <>
      {props.pageEditor ? <PageEditorModal {...props.pageEditor} /> : null}
      <ImportFlowModals {...props} />
      <ShareFlowModals {...props} />
      <EditAndSettingsModals {...props} />
      <SystemModals {...props} />
    </>
  );
}

type ImportFlowModalProps = Pick<
  AppModalsProps,
  | "addPagesChapter"
  | "onClearAddPages"
  | "importBusy"
  | "importDraft"
  | "importFeedback"
  | "importPreview"
  | "library"
  | "currentChapterId"
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
>;

function ImportFlowModals({
  currentChapterId,
  addPagesChapter,
  onClearAddPages,
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
}: ImportFlowModalProps): React.JSX.Element {
  return (
    <>
      {translationSourceOpen ? (
        <TranslateSourceModal
          busy={importBusy}
          addingPages={Boolean(addPagesChapter)}
          onCancel={() => {
            onCancelTranslationSource();
            onClearAddPages?.();
          }}
          onSelect={onSelectTranslationSource}
        />
      ) : null}
      {webImportOpen ? (
        <WebImportModal
          onCancel={() => {
            onCancelWebImport();
            onClearAddPages?.();
          }}
          onBackgroundStateChange={onWebImportBackgroundStateChange}
          onEntered={onCancelTranslationSource}
          onPrepared={onPreparedWebImport}
        />
      ) : null}
      {importPreview ? (
        <ImportModal
          library={library}
          currentWorkId={currentWorkId}
          currentChapterId={currentChapterId}
          addPagesChapter={addPagesChapter}
          preview={importPreview}
          busy={importBusy}
          initialDraft={importDraft}
          feedback={importFeedback}
          onEntered={() => {
            onCancelTranslationSource();
            onCancelWebImport();
          }}
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
  onOpenErrorReport,
  onOpenLogFolder,
  onOpenModelFolder,
  onResetSettings,
  onSubmitRename,
  onSubmitSettings,
  renameBusy,
  renameTarget,
  settings,
  settingsBusy,
  settingsOpen,
  settingsRecovery,
  settingsOpenRequest,
}: Pick<
  AppModalsProps,
  | "jobActive"
  | "library"
  | "onCancelRename"
  | "onCancelSettings"
  | "onOpenErrorReport"
  | "onOpenLogFolder"
  | "onOpenModelFolder"
  | "onResetSettings"
  | "onSubmitRename"
  | "onSubmitSettings"
  | "renameBusy"
  | "renameTarget"
  | "settings"
  | "settingsBusy"
  | "settingsOpen"
  | "settingsRecovery"
  | "settingsOpenRequest"
>): React.JSX.Element {
  return (
    <>
      <LibraryEditModals
        onCancelRename={onCancelRename}
        onSubmitRename={onSubmitRename}
        renameBusy={renameBusy}
        renameTarget={renameTarget}
      />
      {settingsOpen ? (
        <SettingsModal
          initialSettings={settings}
          recovery={settingsRecovery}
          openRequest={settingsOpenRequest}
          library={library}
          busy={settingsBusy}
          jobActive={jobActive}
          onCancel={onCancelSettings}
          onOpenErrorReport={onOpenErrorReport}
          onOpenLogFolder={onOpenLogFolder}
          onOpenModelFolder={onOpenModelFolder}
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
          option={confirmDialog.option}
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
