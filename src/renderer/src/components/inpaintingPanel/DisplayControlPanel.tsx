import React from "react";
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
  return (
    <section className="display-panel">
      <h2>표시</h2>
      <div className="display-toggle-row">
        <button
          className={showBlockChrome ? "active" : ""}
          onClick={onToggleChrome}
        >
          배경/테두리
        </button>
        <button
          className={showTextBlocks ? "active" : ""}
          onClick={onToggleBlocks}
        >
          블록 표시
        </button>
      </div>
      <Button fullWidth onClick={onOpenTextView} disabled={!canOpenTextView}>
        텍스트 모아보기
      </Button>
      <Button fullWidth onClick={onOpenStyleGuide} disabled={!canOpenTextView}>
        용어/기억
      </Button>
    </section>
  );
}
