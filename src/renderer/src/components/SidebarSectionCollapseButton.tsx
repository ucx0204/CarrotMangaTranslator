import React from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./ui/IconButton";
import { ChevronDownIcon } from "./ui/icons";

export function SidebarSectionCollapseButton({
  collapsed,
  controls,
  direction,
  onToggle,
  sectionTitle,
}: {
  collapsed: boolean;
  controls: string;
  direction: "up" | "down";
  onToggle: () => void;
  sectionTitle: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const label = t(
    collapsed ? "common.expandSection" : "common.collapseSection",
    { title: sectionTitle },
  );
  return (
    <IconButton
      size="sm"
      className="sidebar-section-collapse-button"
      label={label}
      aria-controls={controls}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <ChevronDownIcon
        size={16}
        className={
          direction === "up" ? "sidebar-section-collapse-chevron-up" : ""
        }
      />
    </IconButton>
  );
}
