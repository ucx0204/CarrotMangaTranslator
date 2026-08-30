import type { Dispatch, SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { ImportPreviewSession } from "../../../shared/importTypes";
import type {
  WorkShareExportRequest,
  WorkShareImportPreview,
} from "../../../shared/shareTypes";
import type {
  ImportModalFeedback,
  ImportModalSubmit,
  TranslateSourceMode,
} from "../lib/importFlowTypes";
import type { ShareImportModalSubmit } from "../lib/shareImportTypes";
import type { TranslationOptionsInitialScope } from "../lib/translationSelection";

type ImportPreviewMode = Exclude<TranslateSourceMode, "web"> | "zip-folder";

export type ErrorMessageFormatter = (
  error: unknown,
  fallbackMessage: string,
) => string;

export type UseImportShareActionsOptions = {
  applyChapter: (
    chapter: ChapterSnapshot | undefined,
    fallbackStatus?: string,
  ) => void;
  askConfirm: (
    title: string,
    message: string,
    detail?: string,
  ) => Promise<boolean>;
  dirty: boolean;
  getNavigationKey: () => string;
  importPreview: ImportPreviewSession | null;
  openTranslateOptions: (initialScope?: TranslationOptionsInitialScope) => void;
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  resetWorkspaceHistory: () => void;
  saveNow: () => Promise<void>;
  setImportBusy: Dispatch<SetStateAction<boolean>>;
  setImportModalOpen?: Dispatch<SetStateAction<boolean>>;
  setImportDraft?: Dispatch<SetStateAction<ImportModalSubmit | null>>;
  setImportFeedback?: Dispatch<SetStateAction<ImportModalFeedback | null>>;
  setImportPreview: Dispatch<SetStateAction<ImportPreviewSession | null>>;
  setShareExportBusy: Dispatch<SetStateAction<boolean>>;
  setShareExportDraft: Dispatch<SetStateAction<WorkShareExportRequest | null>>;
  setShareExportOpen: Dispatch<SetStateAction<boolean>>;
  setShareImportBusy: Dispatch<SetStateAction<boolean>>;
  setShareImportDraft: Dispatch<SetStateAction<ShareImportModalSubmit | null>>;
  setShareImportPreview: Dispatch<
    SetStateAction<WorkShareImportPreview | null>
  >;
  setTranslationSourceOpen: Dispatch<SetStateAction<boolean>>;
  setWebImportOpen: Dispatch<SetStateAction<boolean>>;
  shareImportPreview: WorkShareImportPreview | null;
};

export type ImportShareActions = {
  openImportPreview: (mode: ImportPreviewMode) => Promise<void>;
  openShareImportPreview: () => Promise<void>;
  selectTranslateSource: (mode: TranslateSourceMode) => Promise<void>;
  acceptWebImportPreview: (preview: ImportPreviewSession) => void;
  cancelImportPreview: () => Promise<void>;
  submitImport: (payload: ImportModalSubmit) => Promise<void>;
  submitShareExport: (request: WorkShareExportRequest) => Promise<void>;
  submitShareImport: (payload: ShareImportModalSubmit) => Promise<void>;
};
