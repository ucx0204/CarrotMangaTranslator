import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";

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
      <div className="display-toggle-row">
        <button
          className={showBlockChrome ? "active" : ""}
          onClick={onToggleChrome}
        >
          {t("display.backgroundBorders")}
        </button>
        <button
          className={showTextBlocks ? "active" : ""}
          onClick={onToggleBlocks}
        >
          {t("display.showBlocks")}
        </button>
      </div>
      <Button fullWidth onClick={onOpenTextView} disabled={!canOpenTextView}>
        {t("display.gatherText")}
      </Button>
      <Button fullWidth onClick={onOpenStyleGuide} disabled={!canOpenTextView}>
        {t("display.styleGuide")}
      </Button>
    </section>
  );
}
