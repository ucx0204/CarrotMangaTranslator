import { useMemo } from "react";
import type { ChapterSnapshot } from "../../../shared/types";
import type { Command } from "../components/CommandPalette";

type UseAppCommandsOptions = {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  inpaintingMode: boolean;
  runAnalysis: (runMode: "pending" | "all") => Promise<void>;
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
  return useMemo(() => {
    const list: Command[] = [];
    if (currentChapter && !jobActive && !inpaintingMode) {
      list.push({
        id: "translate-pending",
        label: "이어서 번역",
        hint: "남은 페이지",
        keywords: "translate resume ieoseo",
        run: () => void runAnalysis("pending"),
      });
      list.push({
        id: "translate-all",
        label: "전체 다시 번역",
        hint: "모든 페이지",
        keywords: "translate all retranslate jeonche",
        run: () => void runAnalysis("all"),
      });
      list.push({
        id: "enter-inpainting",
        label: "인페인팅 시작",
        keywords: "inpaint",
        run: () => void enterInpaintingMode(),
      });
    }
    if (inpaintingMode) {
      list.push({
        id: "exit-inpainting",
        label: "인페인팅 종료",
        keywords: "inpaint exit",
        run: () => exitInpaintingMode(),
      });
    }
    if (jobActive) {
      list.push({
        id: "cancel-job",
        label: "작업 취소",
        keywords: "cancel stop",
        run: cancelJob,
      });
    }
    if (currentChapter) {
      list.push({
        id: "gather-text",
        label: "텍스트 모아보기",
        hint: "페이지·전체 화",
        keywords: "text copy gather moaboki 복사 모아보기",
        run: openTextView,
      });
    }
    list.push({
      id: "open-translate-source",
      label: "번역 소스 가져오기",
      hint: "이미지·폴더·ZIP",
      keywords: "import source",
      run: openTranslationSource,
    });
    list.push({
      id: "open-batch",
      label: "작품 일괄 번역",
      keywords: "batch import",
      run: () => void openImportPreview("zip-folder"),
    });
    list.push({
      id: "open-share-import",
      label: "공유본 가져오기",
      keywords: "share import",
      run: () => void openShareImportPreview(),
    });
    list.push({
      id: "open-share-export",
      label: "공유로 내보내기",
      keywords: "share export",
      run: openShareExport,
    });
    list.push({
      id: "open-settings",
      label: "설정 열기",
      keywords: "settings",
      run: () => void openSettings(),
    });
    list.push({
      id: "open-library-folder",
      label: "보관함 폴더 열기",
      keywords: "library folder",
      run: openLibraryFolder,
    });
    list.push({
      id: "open-log-folder",
      label: "로그 폴더 열기",
      keywords: "log folder",
      run: openLogFolder,
    });
    list.push({
      id: "show-shortcuts",
      label: "단축키 도움말",
      keywords: "shortcut help",
      run: openShortcutHelp,
    });
    return list;
  }, [
    currentChapter,
    jobActive,
    inpaintingMode,
    runAnalysis,
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
  ]);
}
