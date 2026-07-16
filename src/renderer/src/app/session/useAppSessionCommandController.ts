import { type Dispatch, type SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { Command } from "../../lib/appCommandTypes";
import { useAppCommands } from "../../hooks/useAppCommands";

type UseAppSessionCommandControllerArgs = {
  cancelJob: () => void;
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  openImportPreview: (mode: "zip-folder") => Promise<void>;
  openLibraryFolder: () => void;
  openLogFolder: () => void;
  openErrorReport: () => void;
  openSettings: () => Promise<void> | void;
  openShareImportPreview: () => Promise<void>;
  runAnalysis: (runMode: "pending" | "all") => void;
  runCurrentPageInpainting: () => void;
  setShareExportOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutHelpOpen: Dispatch<SetStateAction<boolean>>;
  setTextViewOpen: Dispatch<SetStateAction<boolean>>;
  setTranslateOptionsOpen: Dispatch<SetStateAction<boolean>>;
  setTranslationSourceOpen: Dispatch<SetStateAction<boolean>>;
};

export function useAppSessionCommandController({
  cancelJob,
  currentChapter,
  jobActive,
  openImportPreview,
  openLibraryFolder,
  openLogFolder,
  openErrorReport,
  openSettings,
  openShareImportPreview,
  runAnalysis,
  runCurrentPageInpainting,
  setShareExportOpen,
  setShortcutHelpOpen,
  setTextViewOpen,
  setTranslateOptionsOpen,
  setTranslationSourceOpen,
}: UseAppSessionCommandControllerArgs): Command[] {
  return useAppCommands({
    cancelJob,
    currentChapter,
    jobActive,
    openImportPreview,
    openLibraryFolder,
    openLogFolder,
    openErrorReport,
    openSettings,
    openShareExport: () => setShareExportOpen(true),
    openShareImportPreview,
    openShortcutHelp: () => setShortcutHelpOpen(true),
    openTextView: () => setTextViewOpen(true),
    openTranslateOptions: () => setTranslateOptionsOpen(true),
    openTranslationSource: () => setTranslationSourceOpen(true),
    runAnalysis,
    runCurrentPageInpainting,
  });
}
