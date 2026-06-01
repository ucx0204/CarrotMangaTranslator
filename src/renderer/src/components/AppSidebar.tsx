import React from "react";
import type { ChapterSnapshot, LibraryIndex } from "../../../shared/types";
import { LibraryTree } from "./LibraryTree";
import { PageList } from "./PageList";

export function AppSidebar({
  inpaintingMode,
  currentChapter,
  selectedPageId,
  library,
  jobActive,
  settingsBusy,
  settingsOpen,
  onExitInpainting,
  onOpenTranslationSource,
  onOpenBatchImport,
  onOpenSettings,
  onOpenLibraryFolder,
  onOpenShareExport,
  onOpenShareImport,
  onOpenChapter,
  onRenameWork,
  onRenameChapter,
  onReorderChapter,
  onSelectPage,
  onRetranslatePage,
  onRemovePage,
  onReorderPage
}: {
  inpaintingMode: boolean;
  currentChapter: ChapterSnapshot | null;
  selectedPageId: string | null;
  library: LibraryIndex;
  jobActive: boolean;
  settingsBusy: boolean;
  settingsOpen: boolean;
  onExitInpainting: () => void;
  onOpenTranslationSource: () => void;
  onOpenBatchImport: () => void;
  onOpenSettings: () => void;
  onOpenLibraryFolder: () => void;
  onOpenShareExport: () => void;
  onOpenShareImport: () => void;
  onOpenChapter: (chapterId: string) => void;
  onRenameWork: (workId: string) => void;
  onRenameChapter: (chapterId: string) => void;
  onReorderChapter: (workId: string, sourceChapterId: string, targetChapterId: string) => void;
  onSelectPage: (pageId: string) => void;
  onRetranslatePage: (pageId: string) => void;
  onRemovePage: (pageId: string) => void;
  onReorderPage: (sourcePageId: string, targetPageId: string) => void;
}): React.JSX.Element {
  return (
    <aside className={`sidebar ${inpaintingMode ? "inpainting-sidebar" : ""}`}>
      {inpaintingMode ? (
        <>
          <section className="inpainting-exit-panel">
            <button className="danger" onClick={onExitInpainting} disabled={jobActive}>
              인페인팅 나가기
            </button>
            <small>{currentChapter ? currentChapter.title : "현재 화 없음"}</small>
          </section>

          <PageList
            pages={currentChapter?.pages ?? []}
            selectedPageId={selectedPageId}
            jobActive={true}
            onSelect={onSelectPage}
            onRetranslate={onRetranslatePage}
            onRemove={onRemovePage}
            onReorder={() => undefined}
          />
        </>
      ) : (
        <>
          <section className="toolbar">
            <button className="primary" onClick={onOpenTranslationSource} disabled={jobActive}>
              번역
            </button>
            <button onClick={onOpenBatchImport} disabled={jobActive}>
              작품 일괄 번역
            </button>
            <button onClick={onOpenSettings} disabled={settingsBusy && !settingsOpen}>
              설정
            </button>
            <button onClick={onOpenLibraryFolder}>보관함 폴더</button>
            <button className="share-button" onClick={onOpenShareExport} disabled={jobActive || library.works.length === 0}>
              공유하기
            </button>
            <button className="import-button" onClick={onOpenShareImport} disabled={jobActive}>
              가져오기
            </button>
          </section>

          <LibraryTree
            library={library}
            currentChapterId={currentChapter?.id ?? null}
            jobActive={jobActive}
            onOpenChapter={onOpenChapter}
            onRenameWork={onRenameWork}
            onRenameChapter={onRenameChapter}
            onReorderChapter={onReorderChapter}
          />

          <PageList
            pages={currentChapter?.pages ?? []}
            selectedPageId={selectedPageId}
            jobActive={jobActive}
            onSelect={onSelectPage}
            onRetranslate={onRetranslatePage}
            onRemove={onRemovePage}
            onReorder={onReorderPage}
          />
        </>
      )}
    </aside>
  );
}
