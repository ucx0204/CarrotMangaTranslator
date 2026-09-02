import { type Dispatch, type SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { AppCommandRegistry } from "../../lib/appCommandTypes";
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
  openTextView: () => void;
  setShowBlockChrome: Dispatch<SetStateAction<boolean>>;
  setShowTextBlocks: Dispatch<SetStateAction<boolean>>;
  openTranslateOptions: () => void;
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
  openTextView,
  setShowBlockChrome,
  setShowTextBlocks,
  openTranslateOptions,
  setTranslationSourceOpen,
}: UseAppSessionCommandControllerArgs): AppCommandRegistry {
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
    openTextView,
    toggleBlockChrome: () => setShowBlockChrome((visible) => !visible),
    toggleTextBlocks: () => setShowTextBlocks((visible) => !visible),
    openTranslateOptions,
    openTranslationSource: () => setTranslationSourceOpen(true),
    runAnalysis,
    runCurrentPageInpainting,
  });
}
