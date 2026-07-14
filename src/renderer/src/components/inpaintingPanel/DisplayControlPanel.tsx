import React from "react";
import {
  IconBook2,
  IconBorderAll,
  IconListDetails,
  IconSquareLetterT,
  type TablerIcon,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ControlTooltip } from "../ui/ControlTooltip";

type DisplayControlPanelProps = {
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  canOpenTextView: boolean;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
  onOpenTextView: () => void;
  onOpenStyleGuide: () => void;
};

export function DisplayControlPanel({
  showBlockChrome,
  showTextBlocks,
  canOpenTextView,
  onToggleChrome,
  onToggleBlocks,
  onOpenTextView,
  onOpenStyleGuide,
}: DisplayControlPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="display-panel">
      <h2>{t("display.title")}</h2>
      <div
        className="display-icon-toolbar"
        role="toolbar"
        aria-label={t("display.title")}
      >
        <DisplayIconControl
          active={showBlockChrome}
          Icon={IconBorderAll}
          label={t("display.backgroundBorders")}
          onClick={onToggleChrome}
        />
        <DisplayIconControl
          active={showTextBlocks}
          Icon={IconSquareLetterT}
          label={t("display.showBlocks")}
          onClick={onToggleBlocks}
        />
        <DisplayIconControl
          disabled={!canOpenTextView}
          Icon={IconListDetails}
          label={t("display.gatherText")}
          onClick={onOpenTextView}
        />
        <DisplayIconControl
          disabled={!canOpenTextView}
          Icon={IconBook2}
          label={t("display.styleGuide")}
          onClick={onOpenStyleGuide}
        />
      </div>
    </section>
  );
}

function DisplayIconControl({
  active,
  disabled,
  Icon,
  label,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  Icon: TablerIcon;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <ControlTooltip
      className="display-icon-control"
      content={label}
      placement="top"
    >
      <button
        type="button"
        className={active ? "active" : ""}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon size={22} stroke={2.1} aria-hidden="true" />
      </button>
    </ControlTooltip>
  );
}
