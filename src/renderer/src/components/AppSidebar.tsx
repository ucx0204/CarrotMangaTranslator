import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import { useEventCallback } from "../hooks/useEventCallback";
import { LibraryTree } from "./LibraryTree";
import { PageList } from "./PageList";
import { Button } from "./ui/Button";
import { MacAlphaBadge } from "./MacAlphaBadge";

type AppSidebarProps = {
  currentChapter: ChapterSnapshot | null;
  selectedPageId: string | null;
  library: LibraryIndex;
  jobActive: boolean;
  settingsBusy: boolean;
  settingsOpen: boolean;
  onOpenTranslationSource: () => void;
  onOpenBatchImport: () => void;
  onOpenSettings: () => void;
  onOpenLibraryFolder: () => void;
  onOpenShareExport: () => void;
  onOpenShareImport: () => void;
  onOpenChapter: (chapterId: string) => void;
  onRenameWork: (workId: string) => void;
  onRenameChapter: (chapterId: string) => void;
  onReorderChapter: (
    workId: string,
    sourceChapterId: string,
    targetChapterId: string,
  ) => void;
  onSelectPage: (pageId: string) => void;
  onRetranslatePage: (pageId: string) => void;
  onRemovePage: (pageId: string) => void;
  onReorderPage: (sourcePageId: string, targetPageId: string) => void;
};

export function AppSidebar(props: AppSidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <MacAlphaBadge />
      <LibrarySidebarContent {...props} />
    </aside>
  );
}

function LibrarySidebarContent({
  currentChapter,
  jobActive,
  library,
  onOpenBatchImport,
  onOpenChapter,
  onOpenLibraryFolder,
  onOpenSettings,
  onOpenShareExport,
  onOpenShareImport,
  onOpenTranslationSource,
  onRemovePage,
  onRenameChapter,
  onRenameWork,
  onReorderChapter,
  onReorderPage,
  onRetranslatePage,
  onSelectPage,
  selectedPageId,
  settingsBusy,
  settingsOpen,
}: AppSidebarProps): React.JSX.Element {
  const stableOnOpenChapter = useEventCallback(onOpenChapter);
  const stableOnRemovePage = useEventCallback(onRemovePage);
  const stableOnRenameChapter = useEventCallback(onRenameChapter);
  const stableOnRenameWork = useEventCallback(onRenameWork);
  const stableOnReorderChapter = useEventCallback(onReorderChapter);
  const stableOnReorderPage = useEventCallback(onReorderPage);
  const stableOnRetranslatePage = useEventCallback(onRetranslatePage);
  const stableOnSelectPage = useEventCallback(onSelectPage);
  return (
    <>
      <SidebarToolbar
        jobActive={jobActive}
        library={library}
        onOpenBatchImport={onOpenBatchImport}
        onOpenLibraryFolder={onOpenLibraryFolder}
        onOpenSettings={onOpenSettings}
        onOpenShareExport={onOpenShareExport}
        onOpenShareImport={onOpenShareImport}
        onOpenTranslationSource={onOpenTranslationSource}
        settingsBusy={settingsBusy}
        settingsOpen={settingsOpen}
      />

      <LibraryTree
        library={library}
        currentChapterId={currentChapter?.id ?? null}
        jobActive={jobActive}
        onOpenChapter={stableOnOpenChapter}
        onRenameWork={stableOnRenameWork}
        onRenameChapter={stableOnRenameChapter}
        onReorderChapter={stableOnReorderChapter}
      />

      <PageList
        pages={currentChapter?.pages ?? []}
        selectedPageId={selectedPageId}
        jobActive={jobActive}
        onSelect={stableOnSelectPage}
        onRetranslate={stableOnRetranslatePage}
        onRemove={stableOnRemovePage}
        onReorder={stableOnReorderPage}
      />
    </>
  );
}

function SidebarToolbar({
  jobActive,
  library,
  onOpenBatchImport,
  onOpenLibraryFolder,
  onOpenSettings,
  onOpenShareExport,
  onOpenShareImport,
  onOpenTranslationSource,
  settingsBusy,
  settingsOpen,
}: Pick<
  AppSidebarProps,
  | "jobActive"
  | "library"
  | "onOpenBatchImport"
  | "onOpenLibraryFolder"
  | "onOpenSettings"
  | "onOpenShareExport"
  | "onOpenShareImport"
  | "onOpenTranslationSource"
  | "settingsBusy"
  | "settingsOpen"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="toolbar">
      <Button
        variant="primary"
        fullWidth
        onClick={onOpenTranslationSource}
        disabled={jobActive}
      >
        {t("sidebar.translate")}
      </Button>
      <Button fullWidth onClick={onOpenBatchImport} disabled={jobActive}>
        {t("sidebar.batchTranslate")}
      </Button>
      <Button
        fullWidth
        onClick={onOpenSettings}
        disabled={settingsBusy && !settingsOpen}
      >
        {t("common.settings")}
      </Button>
      <Button fullWidth onClick={onOpenLibraryFolder}>
        {t("sidebar.libraryFolder")}
      </Button>
      <Button
        fullWidth
        onClick={onOpenShareExport}
        disabled={jobActive || library.works.length === 0}
      >
        {t("sidebar.share")}
      </Button>
      <Button fullWidth onClick={onOpenShareImport} disabled={jobActive}>
        {t("sidebar.importWork")}
      </Button>
    </section>
  );
}
