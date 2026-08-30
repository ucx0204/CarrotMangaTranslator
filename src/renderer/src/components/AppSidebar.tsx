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
  libraryMutationBlocked?: boolean;
  lockedPageIds?: ReadonlySet<string>;
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

function LibrarySidebarContent(props: AppSidebarProps): React.JSX.Element {
  const { collapsedPanel, toggleLibraryContent, togglePageContent } =
    useSidebarPanelCollapse();
  const actions = useStableSidebarActions(props);
  return (
    <>
      <SidebarToolbar
        jobActive={props.jobActive}
        library={props.library}
        onOpenBatchImport={props.onOpenBatchImport}
        onOpenLibraryFolder={props.onOpenLibraryFolder}
        onOpenSettings={props.onOpenSettings}
        onOpenShareExport={props.onOpenShareExport}
        onOpenShareImport={props.onOpenShareImport}
        onOpenTranslationSource={props.onOpenTranslationSource}
        settingsBusy={props.settingsBusy}
        settingsOpen={props.settingsOpen}
      />

      <LibraryTree
        collapsed={collapsedPanel === "library"}
        otherPanelCollapsed={collapsedPanel === "pages"}
        library={props.library}
        currentChapterId={props.currentChapter?.id ?? null}
        jobActive={props.libraryMutationBlocked ?? props.jobActive}
        onOpenChapter={actions.onOpenChapter}
        onRenameWork={actions.onRenameWork}
        onRenameChapter={actions.onRenameChapter}
        onReorderChapter={actions.onReorderChapter}
        onToggleOtherPanel={togglePageContent}
      />

      <PageList
        collapsed={collapsedPanel === "pages"}
        otherPanelCollapsed={collapsedPanel === "library"}
        pages={props.currentChapter?.pages ?? []}
        selectedPageId={props.selectedPageId}
        jobActive={props.libraryMutationBlocked ?? props.jobActive}
        lockedPageIds={props.lockedPageIds ?? EMPTY_PAGE_IDS}
        onSelect={actions.onSelectPage}
        onRetranslate={actions.onRetranslatePage}
        onRemove={actions.onRemovePage}
        onReorder={actions.onReorderPage}
        onToggleOtherPanel={toggleLibraryContent}
      />
    </>
  );
}

function useSidebarPanelCollapse(): {
  collapsedPanel: "library" | "pages" | null;
  toggleLibraryContent: () => void;
  togglePageContent: () => void;
} {
  const [collapsedPanel, setCollapsedPanel] = React.useState<
    "library" | "pages" | null
  >(null);
  return {
    collapsedPanel,
    toggleLibraryContent: React.useCallback(
      () =>
        setCollapsedPanel((current) =>
          current === "library" ? null : "library",
        ),
      [],
    ),
    togglePageContent: React.useCallback(
      () =>
        setCollapsedPanel((current) => (current === "pages" ? null : "pages")),
      [],
    ),
  };
}

function useStableSidebarActions(props: AppSidebarProps) {
  return {
    onOpenChapter: useEventCallback(props.onOpenChapter),
    onRemovePage: useEventCallback(props.onRemovePage),
    onRenameChapter: useEventCallback(props.onRenameChapter),
    onRenameWork: useEventCallback(props.onRenameWork),
    onReorderChapter: useEventCallback(props.onReorderChapter),
    onReorderPage: useEventCallback(props.onReorderPage),
    onRetranslatePage: useEventCallback(props.onRetranslatePage),
    onSelectPage: useEventCallback(props.onSelectPage),
  };
}

const EMPTY_PAGE_IDS: ReadonlySet<string> = new Set();

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
