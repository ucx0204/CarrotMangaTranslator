import React from "react";
import type { ChapterSnapshot, LibraryIndex } from "../../../shared/types";
import { LibraryTree } from "./LibraryTree";
import { PageList } from "./PageList";
import { Button } from "./ui";

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
            <Button variant="danger" fullWidth onClick={onExitInpainting} disabled={jobActive}>
              인페인팅 나가기
            </Button>
            <small>{currentChapter ? currentChapter.title : "현재 화 없음"}</small>
          </section>

          <PageList
            pages={currentChapter?.pages ?? []}
            selectedPageId={selectedPageId}
            jobActive={true}
            statusMode="inpainting"
            onSelect={onSelectPage}
            onRetranslate={onRetranslatePage}
            onRemove={onRemovePage}
            onReorder={() => undefined}
          />
        </>
      ) : (
        <>
          <section className="toolbar">
            <Button variant="primary" fullWidth onClick={onOpenTranslationSource} disabled={jobActive}>
              번역
            </Button>
            <Button fullWidth onClick={onOpenBatchImport} disabled={jobActive}>
              작품 일괄 번역
            </Button>
            <Button fullWidth onClick={onOpenSettings} disabled={settingsBusy && !settingsOpen}>
              설정
            </Button>
            <Button fullWidth onClick={onOpenLibraryFolder}>
              보관함 폴더
            </Button>
            <Button fullWidth onClick={onOpenShareExport} disabled={jobActive || library.works.length === 0}>
              공유하기
            </Button>
            <Button fullWidth onClick={onOpenShareImport} disabled={jobActive}>
              가져오기
            </Button>
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
