import React from "react";
import { useTranslation } from "react-i18next";
import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
} from "@tabler/icons-react";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import { useEventCallback } from "../hooks/useEventCallback";
import { LibraryTree } from "./LibraryTree";
import { PageList } from "./PageList";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { MacAlphaBadge } from "./MacAlphaBadge";
import {
  resolveAppCommandLabel,
  type AppCommandId,
  type AppCommandLabels,
} from "../lib/appCommandTypes";
import { useContextRailExpansion } from "./useContextRailExpansion";

type AppSidebarProps = {
  commandLabels?: AppCommandLabels;
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
  const { t } = useTranslation("components");
  const hasChapter = Boolean(props.currentChapter);
  const { contextExpanded, toggleContextExpanded, toggleRef } =
    useContextRailExpansion(props.currentChapter?.id);

  const toggleLabel = t(
    contextExpanded ? "sidebar.hideNavigator" : "sidebar.showNavigator",
  );
  const ToggleIcon = contextExpanded
    ? IconLayoutSidebarLeftCollapse
    : IconLayoutSidebarLeftExpand;
  return (
    <aside
      className={`sidebar ${hasChapter ? "has-chapter" : ""} ${contextExpanded ? "is-context-expanded" : ""}`.trim()}
    >
      {hasChapter ? (
        <IconButton
          ref={toggleRef}
          className="sidebar-context-toggle"
          label={toggleLabel}
          title={toggleLabel}
          aria-expanded={contextExpanded}
          onClick={toggleContextExpanded}
        >
          <ToggleIcon size={19} stroke={2} aria-hidden="true" />
        </IconButton>
      ) : null}
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
        commandLabels={props.commandLabels}
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
  commandLabels,
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
  | "commandLabels"
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
  const label = (id: AppCommandId, fallback: string): string =>
    resolveAppCommandLabel(commandLabels, id, fallback);
  return (
    <section className="toolbar">
      <Button
        variant="secondary"
        fullWidth
        onClick={onOpenTranslationSource}
        disabled={jobActive}
      >
        {label("open-translate-source", t("sidebar.translate"))}
      </Button>
      <Button fullWidth onClick={onOpenBatchImport} disabled={jobActive}>
        {label("open-batch", t("sidebar.batchTranslate"))}
      </Button>
      <Button
        fullWidth
        onClick={onOpenSettings}
        disabled={settingsBusy && !settingsOpen}
      >
        {label("open-settings", t("common.settings"))}
      </Button>
      <Button fullWidth onClick={onOpenLibraryFolder}>
        {label("open-library-folder", t("sidebar.libraryFolder"))}
      </Button>
      <Button
        fullWidth
        onClick={onOpenShareExport}
        disabled={jobActive || library.works.length === 0}
      >
        {label("open-share-export", t("sidebar.share"))}
      </Button>
      <Button fullWidth onClick={onOpenShareImport} disabled={jobActive}>
        {label("open-share-import", t("sidebar.importWork"))}
      </Button>
    </section>
  );
}
