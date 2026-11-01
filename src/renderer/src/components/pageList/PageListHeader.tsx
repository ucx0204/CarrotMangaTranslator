import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../../shared/libraryTypes";
import type { PageListFilter, PageStatusMode } from "./pageListStatus";
import { PageListFilterMenu } from "./PageListFilterMenu";
import { SidebarSectionCollapseButton } from "../SidebarSectionCollapseButton";
import { IconPlus, IconStopwatch } from "@tabler/icons-react";
import { IconButton } from "../ui/IconButton";
import { EditIcon } from "../ui/icons";

type PageListHeaderProps = {
  onAddPages?: () => void;
  onEditPages?: () => void;
  addPagesLabel?: string;
  addPagesDisabled?: boolean;
  collapsed: boolean;
  otherPanelCollapsed: boolean;
  filter: PageListFilter;
  onFilterChange: (filter: PageListFilter) => void;
  onOpenTiming: () => void;
  onToggleOtherPanel: () => void;
  pages: MangaPage[];
  statusMode: PageStatusMode;
  visibleCount: number;
};

export function PageListHeader({
  onAddPages,
  onEditPages,
  addPagesLabel,
  addPagesDisabled,
  collapsed,
  otherPanelCollapsed,
  filter,
  onFilterChange,
  onOpenTiming,
  onToggleOtherPanel,
  pages,
  statusMode,
  visibleCount,
}: PageListHeaderProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="page-list-header">
      <div className="panel-header page-list-title-row">
        <h2>{t("common.pages")}</h2>
        <div className="page-list-header-actions">
          {onAddPages ? (
            <IconButton
              size="sm"
              label={addPagesLabel || t("import.addPages")}
              title={addPagesLabel || t("import.addPages")}
              disabled={addPagesDisabled}
              onClick={onAddPages}
            >
              <IconPlus size={16} aria-hidden="true" />
            </IconButton>
          ) : null}
          {onEditPages && pages.length ? (
            <EditPagesButton
              disabled={addPagesDisabled}
              onClick={onEditPages}
            />
          ) : null}
          {filter !== "all" ? (
            <span className="page-list-visible-count">
              {t("pageList.visibleCount", {
                visible: visibleCount,
                total: pages.length,
              })}
            </span>
          ) : null}
          {pages.length && !collapsed ? (
            <PageListFilterMenu
              filter={filter}
              pages={pages}
              statusMode={statusMode}
              onChange={onFilterChange}
            />
          ) : null}
          {pages.length && !collapsed ? (
            <IconButton
              size="sm"
              label={t("pageList.timing.button")}
              title={t("pageList.timing.button")}
              onClick={onOpenTiming}
            >
              <IconStopwatch size={16} aria-hidden="true" />
            </IconButton>
          ) : null}
          <SidebarSectionCollapseButton
            collapsed={otherPanelCollapsed}
            controls="sidebar-library-panel"
            direction={otherPanelCollapsed ? "down" : "up"}
            onToggle={onToggleOtherPanel}
            sectionTitle={t("library.title")}
          />
        </div>
      </div>
    </div>
  );
}

/** Same pencil as the library's rename buttons: this edits page names and order. */
function EditPagesButton({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <IconButton
      size="sm"
      label={t("pageEditor.title")}
      title={t("pageEditor.title")}
      disabled={disabled}
      onClick={onClick}
    >
      <EditIcon size={16} />
    </IconButton>
  );
}
