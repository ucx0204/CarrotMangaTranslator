import React from "react";
import { useTranslation } from "react-i18next";
import { IconChevronUp, IconChevronDown } from "@tabler/icons-react";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { IconButton } from "./ui/IconButton";
export function CompactPageNavigation({
  currentChapter,
  selectedPageId,
  onSelectPage,
}: {
  currentChapter: ChapterSnapshot | null;
  selectedPageId: string | null;
  onSelectPage: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const pages = currentChapter?.pages ?? [];
  const index = pages.findIndex((page) => page.id === selectedPageId);
  return (
    <nav className="sidebar-compact-pages" aria-label={t("common.pages")}>
      <IconButton
        size="sm"
        label={t("sidebar.previousPage")}
        disabled={index <= 0}
        onClick={() => onSelectPage(pages[index - 1].id)}
      >
        <IconChevronUp size={16} />
      </IconButton>
      <span aria-live="polite">
        {index + 1}/{pages.length}
      </span>
      <IconButton
        size="sm"
        label={t("sidebar.nextPage")}
        disabled={index < 0 || index >= pages.length - 1}
        onClick={() => onSelectPage(pages[index + 1].id)}
      >
        <IconChevronDown size={16} />
      </IconButton>
    </nav>
  );
}
