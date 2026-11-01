import { CompactPageNavigation } from "./CompactPageNavigation";
import type { LibraryContextActions } from "../hooks/libraryActionTypes";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMessageCircle,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import { useEventCallback } from "../hooks/useEventCallback";
import { LibraryTree } from "./LibraryTree";
import { PageList } from "./PageList";
import { ActionMenu } from "./ui/ActionMenu";
import { IconButton } from "./ui/IconButton";
import { ResizeHandle } from "./ui/ResizeHandle";
import { SidebarWidthResizer } from "./SidebarWidthResizer";
import { MacAlphaBadge } from "./MacAlphaBadge";
import {
  resolveAppCommandLabel,
  type AppCommand,
  type AppCommandId,
  type AppCommandLabels,
} from "../lib/appCommandTypes";
import { useContextRailExpansion } from "./useContextRailExpansion";
import {
  useSidebarPanelLayout,
  type SidebarPanelLayout,
} from "./useSidebarPanelLayout";

type AppSidebarProps = {
  chatOpen?: boolean;
  commandLabels?: AppCommandLabels;
  currentChapter: ChapterSnapshot | null;
  selectedPageId: string | null;
  library: LibraryIndex;
  jobActive: boolean;
  libraryMutationBlocked?: boolean;
  pageStructureBlocked?: boolean;
  lockedPageIds?: ReadonlySet<string>;
  removalLockedPageIds?: ReadonlySet<string>;
  /** A job the current translation provider cannot run beside. */
  translationBlocked?: boolean;
  settingsBusy: boolean;
  settingsOpen: boolean;
  onOpenTranslationSource: () => void;
  onAddChapterPages?: () => void;
  onEditPages?: () => void;
  onOpenBatchImport: () => void;
  onOpenSettings: () => void;
  onOpenChat?: () => void;
  onOpenLibraryFolder: () => void;
  onOpenShareExport: () => void;
  onOpenShareImport: () => void;
  onOpenChapter: (chapterId: string) => void;
  contextActions?: LibraryContextActions;
  /** Explicit all-works result folder repair, shared with the palette. */
  organizeAllResults?: AppCommand<"organize-all-linked-results"> & {
    busy: boolean;
  };
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
    <>
      <SidebarAside {...props} />
      {/* A sibling inside the app shell, so it can straddle the rail's edge. */}
      <SidebarWidthResizer />
    </>
  );
}

function SidebarAside(props: AppSidebarProps): React.JSX.Element {
  const { contextExpanded, toggleContextExpanded, toggleRef } =
    useContextRailExpansion(props.currentChapter?.id);
  const layout = useSidebarPanelLayout();
  const { t } = useTranslation("components");
  const hasChapter = Boolean(props.currentChapter);
  const toggleLabel = t(
    contextExpanded ? "sidebar.hideNavigator" : "sidebar.showNavigator",
  );
  const ToggleIcon = contextExpanded
    ? IconLayoutSidebarLeftCollapse
    : IconLayoutSidebarLeftExpand;
  return (
    <aside
      className={[
        "sidebar",
        hasChapter ? "has-chapter" : "",
        contextExpanded ? "is-context-expanded" : "",
        layout.librarySplit === null ? "" : "has-custom-split",
      ]
        .filter(Boolean)
        .join(" ")}
      style={layout.splitStyle}
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
      {hasChapter ? <CompactPageNavigation {...props} /> : null}
      <MacAlphaBadge />
      <LibrarySidebarContent {...props} layout={layout} />
    </aside>
  );
}

function LibrarySidebarContent({
  layout,
  ...props
}: AppSidebarProps & { layout: SidebarPanelLayout }): React.JSX.Element {
  const { collapsedPanel, toggleLibraryContent, togglePageContent } = layout;
  const actions = useStableSidebarActions(props);
  const splitResizable =
    collapsedPanel === null && Boolean(props.currentChapter?.pages.length);
  return (
    <>
      <SidebarToolbar
        chatAvailable={!props.currentChapter && !props.chatOpen}
        commandLabels={props.commandLabels}
        jobActive={props.jobActive}
        library={props.library}
        onOpenBatchImport={props.onOpenBatchImport}
        onOpenLibraryFolder={props.onOpenLibraryFolder}
        onOpenSettings={props.onOpenSettings}
        onOpenChat={props.onOpenChat}
        onOpenShareExport={props.onOpenShareExport}
        onOpenShareImport={props.onOpenShareImport}
        onOpenTranslationSource={props.onOpenTranslationSource}
        organizeAllResults={props.organizeAllResults}
        settingsBusy={props.settingsBusy}
        settingsOpen={props.settingsOpen}
      />

      <LibraryTree
        contextActions={props.contextActions}
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

      {splitResizable ? <SidebarSplitHandle layout={layout} /> : null}

      <PageList
        onEditPages={props.onEditPages}
        onAddPages={props.currentChapter ? props.onAddChapterPages : undefined}
        addPagesLabel={resolveAppCommandLabel(
          props.commandLabels,
          "add-chapter-pages",
          "",
        )}
        {...currentChapterPages(props.currentChapter)}
        collapsed={collapsedPanel === "pages"}
        otherPanelCollapsed={collapsedPanel === "library"}
        selectedPageId={props.selectedPageId}
        jobActive={
          props.pageStructureBlocked ??
          props.libraryMutationBlocked ??
          props.jobActive
        }
        lockedPageIds={props.lockedPageIds ?? EMPTY_PAGE_IDS}
        removalLockedPageIds={props.removalLockedPageIds}
        translationBlocked={props.translationBlocked}
        onSelect={actions.onSelectPage}
        onRetranslate={actions.onRetranslatePage}
        onRemove={actions.onRemovePage}
        onReorder={actions.onReorderPage}
        onToggleOtherPanel={toggleLibraryContent}
      />
    </>
  );
}

function SidebarSplitHandle({
  layout,
}: {
  layout: SidebarPanelLayout;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ResizeHandle
      orientation="horizontal"
      className="sidebar-split-handle"
      label={t("sidebar.resizeSplit")}
      title={t("sidebar.resizeSplitHint")}
      valueNow={
        layout.librarySplit === null
          ? undefined
          : Math.round(layout.librarySplit * 100)
      }
      valueMin={0}
      valueMax={100}
      onResizeStart={layout.onSplitResizeStart}
      onResize={layout.onSplitResize}
      onResizeEnd={layout.onSplitResizeEnd}
      onReset={layout.resetSplit}
    />
  );
}

function currentChapterPages(chapter: ChapterSnapshot | null): {
  chapterId: string | null;
  pages: ChapterSnapshot["pages"];
} {
  return { chapterId: chapter?.id ?? null, pages: chapter?.pages ?? [] };
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

type SidebarToolbarProps = Pick<
  AppSidebarProps,
  | "jobActive"
  | "commandLabels"
  | "library"
  | "onOpenBatchImport"
  | "onOpenLibraryFolder"
  | "onOpenSettings"
  | "onOpenChat"
  | "onOpenShareExport"
  | "onOpenShareImport"
  | "onOpenTranslationSource"
  | "organizeAllResults"
  | "settingsBusy"
  | "settingsOpen"
> & {
  /** The right rail's chat tab is unreachable while no chapter is open. */
  chatAvailable: boolean;
};

function SidebarToolbar({
  chatAvailable,
  commandLabels,
  jobActive,
  library,
  onOpenBatchImport,
  onOpenLibraryFolder,
  onOpenSettings,
  onOpenChat,
  onOpenShareExport,
  onOpenShareImport,
  onOpenTranslationSource,
  organizeAllResults,
  settingsBusy,
  settingsOpen,
}: SidebarToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const label = (id: AppCommandId, fallback: string): string =>
    resolveAppCommandLabel(commandLabels, id, fallback);
  const settingsLabel = label("open-settings", t("common.settings"));
  const chatLabel = label("open-chat", t("chat.open"));
  return (
    <section className="toolbar">
      <ActionMenu
        label={t("sidebar.addSource")}
        triggerIcon={<IconPlus size={16} aria-hidden="true" />}
        disabled={jobActive}
        items={[
          {
            label: label("open-translate-source", t("sidebar.translate")),
            run: onOpenTranslationSource,
          },
          {
            label: label("open-batch", t("sidebar.batchTranslate")),
            run: onOpenBatchImport,
          },
        ]}
      />
      <div className="toolbar-icons">
        {chatAvailable && onOpenChat ? (
          <IconButton label={chatLabel} onClick={onOpenChat}>
            <IconMessageCircle size={18} aria-hidden="true" />
          </IconButton>
        ) : null}
        <IconButton
          label={settingsLabel}
          onClick={onOpenSettings}
          disabled={settingsBusy && !settingsOpen}
        >
          <IconSettings size={18} aria-hidden="true" />
        </IconButton>
        <SidebarMoreMenu
          commandLabels={commandLabels}
          jobActive={jobActive}
          library={library}
          onOpenLibraryFolder={onOpenLibraryFolder}
          onOpenShareExport={onOpenShareExport}
          onOpenShareImport={onOpenShareImport}
          organizeAllResults={organizeAllResults}
        />
      </div>
    </section>
  );
}

/** Occasional file actions: library folder and work export/import. */
function SidebarMoreMenu({
  commandLabels,
  jobActive,
  library,
  onOpenLibraryFolder,
  onOpenShareExport,
  onOpenShareImport,
  organizeAllResults,
}: Pick<
  SidebarToolbarProps,
  | "commandLabels"
  | "jobActive"
  | "library"
  | "onOpenLibraryFolder"
  | "onOpenShareExport"
  | "onOpenShareImport"
  | "organizeAllResults"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  const label = (id: AppCommandId, fallback: string): string =>
    resolveAppCommandLabel(commandLabels, id, fallback);
  return (
    <ActionMenu
      label={t("sidebar.more")}
      iconOnly
      align="end"
      tooltipPlacement="bottom"
      items={[
        {
          label: label("open-library-folder", t("sidebar.libraryFolder")),
          run: onOpenLibraryFolder,
        },
        {
          label: label("open-share-export", t("sidebar.share")),
          run: onOpenShareExport,
          disabled: jobActive || library.works.length === 0,
        },
        {
          label: label("open-share-import", t("sidebar.importWork")),
          run: onOpenShareImport,
          disabled: jobActive,
        },
        ...(organizeAllResults?.paletteVisible
          ? [
              {
                label: organizeAllResults.label,
                run: organizeAllResults.run,
                disabled: organizeAllResults.busy,
              },
            ]
          : []),
      ]}
    />
  );
}
