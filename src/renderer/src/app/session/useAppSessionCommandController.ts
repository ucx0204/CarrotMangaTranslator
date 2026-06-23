import { type Dispatch, type SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { Command } from "../../components/CommandPalette";
import { useAppCommands } from "../../hooks/useAppCommands";

type UseAppSessionCommandControllerArgs = {
  cancelJob: () => void;
  currentChapter: ChapterSnapshot | null;
  enterInpaintingMode: () => Promise<void>;
  exitInpaintingMode: () => void;
  inpaintingMode: boolean;
  jobActive: boolean;
  openImportPreview: (mode: "zip-folder") => Promise<void>;
  openLibraryFolder: () => void;
  openLogFolder: () => void;
  openSettings: () => Promise<void> | void;
  openShareImportPreview: () => Promise<void>;
  runAnalysis: (runMode: "pending" | "all") => void;
  setShareExportOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutHelpOpen: Dispatch<SetStateAction<boolean>>;
  setTextViewOpen: Dispatch<SetStateAction<boolean>>;
  setTranslateOptionsOpen: Dispatch<SetStateAction<boolean>>;
  setTranslationSourceOpen: Dispatch<SetStateAction<boolean>>;
};

export function useAppSessionCommandController({
  cancelJob,
  currentChapter,
  enterInpaintingMode,
  exitInpaintingMode,
  inpaintingMode,
  jobActive,
  openImportPreview,
  openLibraryFolder,
  openLogFolder,
  openSettings,
  openShareImportPreview,
  runAnalysis,
  setShareExportOpen,
  setShortcutHelpOpen,
  setTextViewOpen,
  setTranslateOptionsOpen,
  setTranslationSourceOpen,
}: UseAppSessionCommandControllerArgs): Command[] {
  return useAppCommands({
    cancelJob,
    currentChapter,
    enterInpaintingMode,
    exitInpaintingMode,
    inpaintingMode,
    jobActive,
    openImportPreview,
    openLibraryFolder,
    openLogFolder,
    openSettings,
    openShareExport: () => setShareExportOpen(true),
    openShareImportPreview,
    openShortcutHelp: () => setShortcutHelpOpen(true),
    openTextView: () => setTextViewOpen(true),
    openTranslateOptions: () => setTranslateOptionsOpen(true),
    openTranslationSource: () => setTranslationSourceOpen(true),
    runAnalysis,
  });
}
