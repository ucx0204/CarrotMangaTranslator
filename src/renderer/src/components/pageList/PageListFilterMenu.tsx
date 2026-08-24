import React from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../../shared/libraryTypes";
import { IconButton } from "../ui/IconButton";
import { FilterIcon } from "../ui/icons";
import { RadioMenu } from "../ui/RadioMenu";
import { usePopupController } from "../ui/usePopupController";
import {
  matchesPageFilter,
  type PageListFilter,
  type PageStatusMode,
} from "./pageListStatus";

export function PageListFilterMenu({
  filter,
  onChange,
  pages,
  statusMode,
}: {
  filter: PageListFilter;
  onChange: (filter: PageListFilter) => void;
  pages: MangaPage[];
  statusMode: PageStatusMode;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [open, setOpen] = React.useState(false);
  const { close, contentRef, openPopup, rootRef, toggle, triggerRef } =
    usePopupController({
      initialFocus: '[role="menuitemradio"][aria-checked="true"]',
      open,
      onOpenChange: setOpen,
    });
  const options: PageListFilter[] =
    statusMode === "inpainting"
      ? ["all", "pending", "completed"]
      : ["all", "running", "failed", "pending", "completed"];
  const selectedLabel = t(`pageList.filters.${filter}`);
  const triggerLabel = `${t("pageList.filterLabel")}: ${selectedLabel}`;
  return (
    <div
      ref={rootRef}
      className={`page-list-filter-menu ${open ? "open" : ""}`}
    >
      <IconButton
        ref={triggerRef}
        size="sm"
        label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={filter !== "all"}
        onClick={toggle}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Enter" ||
            event.key === " "
          ) {
            event.preventDefault();
            openPopup();
          }
        }}
      >
        <FilterIcon size={16} />
      </IconButton>
      {open ? (
        <RadioMenu
          ariaLabel={t("pageList.filterLabel")}
          menuRef={contentRef}
          options={options.map((option) => ({
            value: option,
            label: t(`pageList.filters.${option}`),
            meta: pages.filter((page) =>
              matchesPageFilter(page, option, statusMode),
            ).length,
          }))}
          value={filter}
          onChange={onChange}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
