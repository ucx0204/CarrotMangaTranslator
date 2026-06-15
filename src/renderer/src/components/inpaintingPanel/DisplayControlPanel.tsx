import React from "react";

type DisplayControlPanelProps = {
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
};

export function DisplayControlPanel({
  showBlockChrome,
  showTextBlocks,
  onToggleChrome,
  onToggleBlocks,
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
    </section>
  );
}
