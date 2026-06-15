import React from "react";
import { Modal } from "./ui";

type ShortcutHelpProps = {
  open: boolean;
  onClose: () => void;
};

const SHORTCUTS: { keys: string[]; desc: string }[] = [
  { keys: ["Ctrl", "K"], desc: "명령 팔레트 열기" },
  { keys: ["?"], desc: "이 단축키 도움말" },
  { keys: ["←", "→"], desc: "이전 / 다음 페이지" },
  { keys: ["Ctrl", "Z"], desc: "인페인팅 보정 실행 취소" },
  { keys: ["Ctrl", "Y"], desc: "인페인팅 보정 다시 실행" },
  { keys: ["Esc"], desc: "모달 닫기 · 드래그 / 영역 선택 취소" },
];

export function ShortcutHelp({
  open,
  onClose,
}: ShortcutHelpProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }
  return (
    <Modal ariaLabel="단축키" title="단축키" size="sm" onClose={onClose}>
      <ul className="shortcut-list">
        {SHORTCUTS.map((shortcut) => (
          <li key={shortcut.desc}>
            <span className="shortcut-keys">
              {shortcut.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </span>
            <span className="shortcut-desc">{shortcut.desc}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
