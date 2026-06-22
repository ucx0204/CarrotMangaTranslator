import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ChapterSnapshot } from "../../../../shared/libraryTypes";
import type { Command } from "../../components/CommandPalette";
import { useAppCommands } from "../../hooks/useAppCommands";
import { useGlobalHotkeys } from "../../hooks/useGlobalHotkeys";

type UseAppSessionCommandControllerArgs = {
  blockingModalOpen: boolean;
  cancelJob: () => void;
  commandPaletteOpen: boolean;
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
  setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setShareExportOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutHelpOpen: Dispatch<SetStateAction<boolean>>;
  setTextViewOpen: Dispatch<SetStateAction<boolean>>;
  setTranslateOptionsOpen: Dispatch<SetStateAction<boolean>>;
  setTranslationSourceOpen: Dispatch<SetStateAction<boolean>>;
};

export function useAppSessionCommandController({
  blockingModalOpen,
  cancelJob,
  commandPaletteOpen,
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
  setCommandPaletteOpen,
  setShareExportOpen,
  setShortcutHelpOpen,
  setTextViewOpen,
  setTranslateOptionsOpen,
  setTranslationSourceOpen,
}: UseAppSessionCommandControllerArgs): Command[] {
  const togglePalette = useCallback(
    () => setCommandPaletteOpen((open) => !open),
    [setCommandPaletteOpen],
  );
  const toggleHelp = useCallback(
    () => setShortcutHelpOpen((open) => !open),
    [setShortcutHelpOpen],
  );

  useGlobalHotkeys({
    blockingModalOpen,
    onToggleHelp: toggleHelp,
    onTogglePalette: togglePalette,
    paletteOpen: commandPaletteOpen,
  });

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
