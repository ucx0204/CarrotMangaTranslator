import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import {
  createAppCommandRegistry,
  type AppCommandMap,
  type AppCommandRegistry,
} from "../lib/appCommandTypes";

type UseAppCommandsOptions = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  runAnalysis: (runMode: "pending" | "all") => void;
  openTranslateOptions: () => void;
  runCurrentPageInpainting: () => void;
  cancelJob: () => void;
  openImportPreview: (mode: "zip-folder") => Promise<void>;
  openShareImportPreview: () => Promise<void>;
  openSettings: () => Promise<void> | void;
  openLibraryFolder: () => void;
  openLogFolder: () => void;
  openErrorReport: () => void;
  openTranslationSource: () => void;
  openShareExport: () => void;
  openShortcutHelp: () => void;
  openTextView: () => void;
  toggleBlockChrome: () => void;
  toggleTextBlocks: () => void;
};

export function useAppCommands(
  options: UseAppCommandsOptions,
): AppCommandRegistry {
  const { t } = useTranslation("renderer");
  const {
    cancelJob,
    currentChapter,
    jobActive,
    openErrorReport,
    openImportPreview,
    openLibraryFolder,
    openLogFolder,
    openSettings,
    openShareExport,
    openShareImportPreview,
    openShortcutHelp,
    openTextView,
    openTranslateOptions,
    openTranslationSource,
    runAnalysis,
    runCurrentPageInpainting,
    toggleBlockChrome,
    toggleTextBlocks,
  } = options;
  return useMemo(
    () =>
      buildAppCommandRegistry({
        cancelJob,
        currentChapter,
        jobActive,
        openErrorReport,
        openImportPreview,
        openLibraryFolder,
        openLogFolder,
        openSettings,
        openShareExport,
        openShareImportPreview,
        openShortcutHelp,
        openTextView,
        openTranslateOptions,
        openTranslationSource,
        runAnalysis,
        runCurrentPageInpainting,
        toggleBlockChrome,
        toggleTextBlocks,
        t,
      }),
    [
      cancelJob,
      currentChapter,
      jobActive,
      openErrorReport,
      openImportPreview,
      openLibraryFolder,
      openLogFolder,
      openSettings,
      openShareExport,
      openShareImportPreview,
      openShortcutHelp,
      openTextView,
      openTranslateOptions,
      openTranslationSource,
      runAnalysis,
      runCurrentPageInpainting,
      toggleBlockChrome,
      toggleTextBlocks,
      t,
    ],
  );
}

type LocalizedCommandOptions = UseAppCommandsOptions & {
  t: TFunction<"renderer">;
};

function buildAppCommandRegistry(
  options: LocalizedCommandOptions,
): AppCommandRegistry {
  const byId = {
    ...buildTranslationCommands(options),
    ...buildInpaintingCommands(options),
    ...buildJobCommands(options),
    ...buildChapterCommands(options),
    ...buildGlobalCommands(options),
  } satisfies AppCommandMap;
  return createAppCommandRegistry(byId);
}

type TranslationCommandId =
  | "open-translate-options"
  | "translate-pending"
  | "translate-all";

function buildTranslationCommands({
  currentChapter,
  jobActive,
  openTranslateOptions,
  runAnalysis,
  t,
}: LocalizedCommandOptions): Pick<AppCommandMap, TranslationCommandId> {
  const paletteVisible = Boolean(currentChapter) && !jobActive;
  return {
    "open-translate-options": {
      id: "open-translate-options",
      label: t("commands.translate.label"),
      hint: t("commands.translate.hint"),
      keywords: t("commands.translate.keywords"),
      paletteVisible,
      run: openTranslateOptions,
    },
    "translate-pending": {
      id: "translate-pending",
      label: t("commands.translatePending.label"),
      hint: t("commands.translatePending.hint"),
      keywords: t("commands.translatePending.keywords"),
      paletteVisible,
      run: () => void runAnalysis("pending"),
    },
    "translate-all": {
      id: "translate-all",
      label: t("commands.translateAll.label"),
      hint: t("commands.translateAll.hint"),
      keywords: t("commands.translateAll.keywords"),
      paletteVisible,
      run: () => void runAnalysis("all"),
    },
  };
}

function buildInpaintingCommands({
  currentChapter,
  jobActive,
  runCurrentPageInpainting,
  t,
}: LocalizedCommandOptions): Pick<
  AppCommandMap,
  "run-current-page-inpainting"
> {
  return {
    "run-current-page-inpainting": {
      id: "run-current-page-inpainting",
      label: t("commands.autoInpainting.label"),
      keywords: t("commands.autoInpainting.keywords"),
      paletteVisible: Boolean(currentChapter) && !jobActive,
      run: runCurrentPageInpainting,
    },
  };
}

function buildJobCommands({
  jobActive,
  cancelJob,
  t,
}: LocalizedCommandOptions): Pick<AppCommandMap, "cancel-job"> {
  return {
    "cancel-job": {
      id: "cancel-job",
      label: t("commands.cancelJob.label"),
      keywords: t("commands.cancelJob.keywords"),
      paletteVisible: jobActive,
      run: cancelJob,
    },
  };
}

type ChapterCommandId =
  | "toggle-block-chrome"
  | "toggle-text-blocks"
  | "gather-text";

function buildChapterCommands({
  currentChapter,
  openTextView,
  toggleBlockChrome,
  toggleTextBlocks,
  t,
}: LocalizedCommandOptions): Pick<AppCommandMap, ChapterCommandId> {
  const paletteVisible = Boolean(currentChapter);
  return {
    "toggle-block-chrome": {
      id: "toggle-block-chrome",
      label: t("commands.toggleBlockChrome.label"),
      keywords: t("commands.toggleBlockChrome.keywords"),
      paletteVisible,
      run: toggleBlockChrome,
    },
    "toggle-text-blocks": {
      id: "toggle-text-blocks",
      label: t("commands.toggleTextBlocks.label"),
      keywords: t("commands.toggleTextBlocks.keywords"),
      paletteVisible,
      run: toggleTextBlocks,
    },
    "gather-text": {
      id: "gather-text",
      label: t("commands.gatherText.label"),
      hint: t("commands.gatherText.hint"),
      keywords: t("commands.gatherText.keywords"),
      paletteVisible,
      run: openTextView,
    },
  };
}

type GlobalCommandId =
  | "open-translate-source"
  | "open-batch"
  | "open-share-import"
  | "open-share-export"
  | "open-settings"
  | "open-library-folder"
  | "open-log-folder"
  | "report-problem"
  | "show-shortcuts";

function buildGlobalCommands({
  openImportPreview,
  openShareImportPreview,
  openSettings,
  openLibraryFolder,
  openLogFolder,
  openErrorReport,
  openTranslationSource,
  openShareExport,
  openShortcutHelp,
  t,
}: LocalizedCommandOptions): Pick<AppCommandMap, GlobalCommandId> {
  return {
    "open-translate-source": {
      id: "open-translate-source",
      label: t("commands.importSource.label"),
      hint: t("commands.importSource.hint"),
      keywords: t("commands.importSource.keywords"),
      paletteVisible: true,
      run: openTranslationSource,
    },
    "open-batch": {
      id: "open-batch",
      label: t("commands.batchTranslate.label"),
      keywords: t("commands.batchTranslate.keywords"),
      paletteVisible: true,
      run: () => void openImportPreview("zip-folder"),
    },
    "open-share-import": {
      id: "open-share-import",
      label: t("commands.importShare.label"),
      keywords: t("commands.importShare.keywords"),
      paletteVisible: true,
      run: () => void openShareImportPreview(),
    },
    "open-share-export": {
      id: "open-share-export",
      label: t("commands.exportShare.label"),
      keywords: t("commands.exportShare.keywords"),
      paletteVisible: true,
      run: openShareExport,
    },
    "open-settings": {
      id: "open-settings",
      label: t("commands.openSettings.label"),
      keywords: t("commands.openSettings.keywords"),
      paletteVisible: true,
      run: () => void openSettings(),
    },
    "open-library-folder": {
      id: "open-library-folder",
      label: t("commands.openLibrary.label"),
      keywords: t("commands.openLibrary.keywords"),
      paletteVisible: true,
      run: openLibraryFolder,
    },
    "open-log-folder": {
      id: "open-log-folder",
      label: t("commands.openLogs.label"),
      keywords: t("commands.openLogs.keywords"),
      paletteVisible: true,
      run: openLogFolder,
    },
    "report-problem": {
      id: "report-problem",
      label: t("commands.reportProblem.label"),
      keywords: t("commands.reportProblem.keywords"),
      paletteVisible: true,
      run: openErrorReport,
    },
    "show-shortcuts": {
      id: "show-shortcuts",
      label: t("commands.shortcutHelp.label"),
      keywords: t("commands.shortcutHelp.keywords"),
      paletteVisible: true,
      run: openShortcutHelp,
    },
  };
}
