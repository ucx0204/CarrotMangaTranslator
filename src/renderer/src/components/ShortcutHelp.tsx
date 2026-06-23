import React from "react";
import { formatCombo } from "../lib/shortcuts/comboFromEvent";
import {
  effectiveCombo,
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORY_LABELS,
  SHORTCUT_CATEGORY_ORDER,
  type KeybindingOverrides,
} from "../lib/shortcuts/shortcutActions";
import { Modal } from "./ui";

type ShortcutHelpProps = {
  open: boolean;
  overrides: KeybindingOverrides;
  onClose: () => void;
};

type ShortcutRow = { id: string; keys: string[]; desc: string };

const FIXED_SHORTCUTS: ShortcutRow[] = [
  { id: "nav-horizontal", keys: ["←", "→"], desc: "이전 / 다음 페이지" },
  {
    id: "nav-vertical",
    keys: ["↑", "↓"],
    desc: "이전 / 다음 페이지 (중앙 패널)",
  },
  {
    id: "esc",
    keys: ["Esc"],
    desc: "모달 닫기 · 드래그 / 영역 선택 취소",
  },
];

export function ShortcutHelp({
  open,
  overrides,
  onClose,
}: ShortcutHelpProps): React.JSX.Element | null {
  if (!open) {
    return null;
  }
  return (
    <Modal ariaLabel="단축키" title="단축키" size="md" onClose={onClose}>
      <div className="shortcut-help">
        {SHORTCUT_CATEGORY_ORDER.map((category) => {
          const rows = SHORTCUT_ACTIONS.filter(
            (action) => action.category === category,
          )
            .map((action) => ({
              id: action.id,
              keys: formatCombo(effectiveCombo(action.id, overrides)),
              desc: action.label,
            }))
            .filter((row) => row.keys.length > 0);
          if (rows.length === 0) {
            return null;
          }
          return (
            <ShortcutHelpSection
              key={category}
              rows={rows}
              title={SHORTCUT_CATEGORY_LABELS[category]}
            />
          );
        })}
        <ShortcutHelpSection rows={FIXED_SHORTCUTS} title="탐색" />
        <p className="muted-line modal-note">
          설정 → 단축키에서 변경할 수 있습니다.
        </p>
      </div>
    </Modal>
  );
}

function ShortcutHelpSection({
  rows,
  title,
}: {
  rows: ShortcutRow[];
  title: string;
}): React.JSX.Element {
  return (
    <section className="shortcut-help-section">
      <h3 className="shortcut-help-title">{title}</h3>
      <ul className="shortcut-list">
        {rows.map((row) => (
          <li key={row.id}>
            <span className="shortcut-keys">
              {row.keys.map((key, index) => (
                <kbd key={`${key}-${index}`}>{key}</kbd>
              ))}
            </span>
            <span className="shortcut-desc">{row.desc}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
