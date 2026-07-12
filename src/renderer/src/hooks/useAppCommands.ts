import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { Command } from "../lib/appCommandTypes";

type UseAppCommandsOptions = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  inpaintingMode: boolean;
  runAnalysis: (runMode: "pending" | "all") => void;
  openTranslateOptions: () => void;
  enterInpaintingMode: () => Promise<void>;
  exitInpaintingMode: () => void;
  cancelJob: () => void;
  openImportPreview: (mode: "zip-folder") => Promise<void>;
  openShareImportPreview: () => Promise<void>;
  openSettings: () => Promise<void> | void;
  openLibraryFolder: () => void;
  openLogFolder: () => void;
  openTranslationSource: () => void;
  openShareExport: () => void;
  openShortcutHelp: () => void;
  openTextView: () => void;
};

export function useAppCommands({
  currentChapter,
  jobActive,
  inpaintingMode,
  runAnalysis,
  openTranslateOptions,
  enterInpaintingMode,
  exitInpaintingMode,
  cancelJob,
  openImportPreview,
  openShareImportPreview,
  openSettings,
  openLibraryFolder,
  openLogFolder,
  openTranslationSource,
  openShareExport,
  openShortcutHelp,
  openTextView,
}: UseAppCommandsOptions): Command[] {
  const { t } = useTranslation("renderer");
  return useMemo(
    () =>
      buildAppCommands({
        currentChapter,
        jobActive,
        inpaintingMode,
        runAnalysis,
        openTranslateOptions,
        enterInpaintingMode,
        exitInpaintingMode,
        cancelJob,
        openImportPreview,
        openShareImportPreview,
        openSettings,
        openLibraryFolder,
        openLogFolder,
        openTranslationSource,
        openShareExport,
        openShortcutHelp,
        openTextView,
        t,
      }),
    [
      currentChapter,
      jobActive,
      inpaintingMode,
      runAnalysis,
      openTranslateOptions,
      enterInpaintingMode,
      exitInpaintingMode,
      cancelJob,
      openImportPreview,
      openShareImportPreview,
      openSettings,
      openLibraryFolder,
      openLogFolder,
      openTranslationSource,
      openShareExport,
      openShortcutHelp,
      openTextView,
      t,
    ],
  );
}

type LocalizedCommandOptions = UseAppCommandsOptions & {
  t: TFunction<"renderer">;
};

function buildAppCommands(options: LocalizedCommandOptions): Command[] {
  return [
    ...buildTranslationCommands(options),
    ...buildInpaintingCommands(options),
    ...buildJobCommands(options),
    ...buildChapterCommands(options),
    ...buildGlobalCommands(options),
  ];
}

function buildTranslationCommands({
  currentChapter,
  jobActive,
  inpaintingMode,
  openTranslateOptions,
  runAnalysis,
  t,
}: LocalizedCommandOptions): Command[] {
  if (!currentChapter || jobActive || inpaintingMode) {
    return [];
  }
  return [
    {
      id: "open-translate-options",
      label: t("commands.translate.label"),
      hint: t("commands.translate.hint"),
      keywords: t("commands.translate.keywords"),
      run: openTranslateOptions,
    },
    {
      id: "translate-pending",
      label: t("commands.translatePending.label"),
      hint: t("commands.translatePending.hint"),
      keywords: t("commands.translatePending.keywords"),
      run: () => void runAnalysis("pending"),
    },
    {
      id: "translate-all",
      label: t("commands.translateAll.label"),
      hint: t("commands.translateAll.hint"),
      keywords: t("commands.translateAll.keywords"),
      run: () => void runAnalysis("all"),
    },
  ];
}

function buildInpaintingCommands({
  currentChapter,
  jobActive,
  inpaintingMode,
  enterInpaintingMode,
  exitInpaintingMode,
  t,
}: LocalizedCommandOptions): Command[] {
  if (inpaintingMode) {
    return [
      {
        id: "exit-inpainting",
        label: t("commands.exitInpainting.label"),
        keywords: t("commands.exitInpainting.keywords"),
        run: () => exitInpaintingMode(),
      },
    ];
  }
  if (!currentChapter || jobActive) {
    return [];
  }
  return [
    {
      id: "enter-inpainting",
      label: t("commands.enterInpainting.label"),
      keywords: t("commands.enterInpainting.keywords"),
      run: () => void enterInpaintingMode(),
    },
  ];
}

function buildJobCommands({
  jobActive,
  cancelJob,
  t,
}: LocalizedCommandOptions): Command[] {
  return jobActive
    ? [
        {
          id: "cancel-job",
          label: t("commands.cancelJob.label"),
          keywords: t("commands.cancelJob.keywords"),
          run: cancelJob,
        },
      ]
    : [];
}

function buildChapterCommands({
  currentChapter,
  openTextView,
  t,
}: LocalizedCommandOptions): Command[] {
  return currentChapter
    ? [
        {
          id: "gather-text",
          label: t("commands.gatherText.label"),
          hint: t("commands.gatherText.hint"),
          keywords: t("commands.gatherText.keywords"),
          run: openTextView,
        },
      ]
    : [];
}

function buildGlobalCommands({
  openImportPreview,
  openShareImportPreview,
  openSettings,
  openLibraryFolder,
  openLogFolder,
  openTranslationSource,
  openShareExport,
  openShortcutHelp,
  t,
}: LocalizedCommandOptions): Command[] {
  return [
    {
      id: "open-translate-source",
      label: t("commands.importSource.label"),
      hint: t("commands.importSource.hint"),
      keywords: t("commands.importSource.keywords"),
      run: openTranslationSource,
    },
    {
      id: "open-batch",
      label: t("commands.batchTranslate.label"),
      keywords: t("commands.batchTranslate.keywords"),
      run: () => void openImportPreview("zip-folder"),
    },
    {
      id: "open-share-import",
      label: t("commands.importShare.label"),
      keywords: t("commands.importShare.keywords"),
      run: () => void openShareImportPreview(),
    },
    {
      id: "open-share-export",
      label: t("commands.exportShare.label"),
      keywords: t("commands.exportShare.keywords"),
      run: openShareExport,
    },
    {
      id: "open-settings",
      label: t("commands.openSettings.label"),
      keywords: t("commands.openSettings.keywords"),
      run: () => void openSettings(),
    },
    {
      id: "open-library-folder",
      label: t("commands.openLibrary.label"),
      keywords: t("commands.openLibrary.keywords"),
      run: openLibraryFolder,
    },
    {
      id: "open-log-folder",
      label: t("commands.openLogs.label"),
      keywords: t("commands.openLogs.keywords"),
      run: openLogFolder,
    },
    {
      id: "show-shortcuts",
      label: t("commands.shortcutHelp.label"),
      keywords: t("commands.shortcutHelp.keywords"),
      run: openShortcutHelp,
    },
  ];
}
