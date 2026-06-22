import { useMemo } from "react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { Command } from "../components/CommandPalette";

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
    ],
  );
}

function buildAppCommands(options: UseAppCommandsOptions): Command[] {
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
}: UseAppCommandsOptions): Command[] {
  if (!currentChapter || jobActive || inpaintingMode) {
    return [];
  }
  return [
    {
      id: "open-translate-options",
      label: "번역…",
      hint: "옵션·2차 번역·일괄",
      keywords: "translate options beonyeok 번역 옵션",
      run: openTranslateOptions,
    },
    {
      id: "translate-pending",
      label: "이어서 번역",
      hint: "남은 페이지 (바로)",
      keywords: "translate resume ieoseo",
      run: () => void runAnalysis("pending"),
    },
    {
      id: "translate-all",
      label: "전체 다시 번역",
      hint: "모든 페이지",
      keywords: "translate all retranslate jeonche",
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
}: UseAppCommandsOptions): Command[] {
  if (inpaintingMode) {
    return [
      {
        id: "exit-inpainting",
        label: "인페인팅 종료",
        keywords: "inpaint exit",
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
      label: "인페인팅 시작",
      keywords: "inpaint",
      run: () => void enterInpaintingMode(),
    },
  ];
}

function buildJobCommands({
  jobActive,
  cancelJob,
}: UseAppCommandsOptions): Command[] {
  return jobActive
    ? [
        {
          id: "cancel-job",
          label: "작업 취소",
          keywords: "cancel stop",
          run: cancelJob,
        },
      ]
    : [];
}

function buildChapterCommands({
  currentChapter,
  openTextView,
}: UseAppCommandsOptions): Command[] {
  return currentChapter
    ? [
        {
          id: "gather-text",
          label: "텍스트 모아보기",
          hint: "페이지·전체 화",
          keywords: "text copy gather moaboki 복사 모아보기",
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
}: UseAppCommandsOptions): Command[] {
  return [
    {
      id: "open-translate-source",
      label: "번역 소스 가져오기",
      hint: "이미지·폴더·ZIP",
      keywords: "import source",
      run: openTranslationSource,
    },
    {
      id: "open-batch",
      label: "작품 일괄 번역",
      keywords: "batch import",
      run: () => void openImportPreview("zip-folder"),
    },
    {
      id: "open-share-import",
      label: "공유본 가져오기",
      keywords: "share import",
      run: () => void openShareImportPreview(),
    },
    {
      id: "open-share-export",
      label: "공유로 내보내기",
      keywords: "share export",
      run: openShareExport,
    },
    {
      id: "open-settings",
      label: "설정 열기",
      keywords: "settings",
      run: () => void openSettings(),
    },
    {
      id: "open-library-folder",
      label: "보관함 폴더 열기",
      keywords: "library folder",
      run: openLibraryFolder,
    },
    {
      id: "open-log-folder",
      label: "로그 폴더 열기",
      keywords: "log folder",
      run: openLogFolder,
    },
    {
      id: "show-shortcuts",
      label: "단축키 도움말",
      keywords: "shortcut help",
      run: openShortcutHelp,
    },
  ];
}
