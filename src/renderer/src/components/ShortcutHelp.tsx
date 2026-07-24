import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { KeybindingOverrides } from "../../../shared/shortcutSettings";
import { formatCombo } from "../lib/shortcuts/comboFromEvent";
import {
  effectiveCombo,
  getShortcutActions,
  getShortcutCategoryLabels,
  SHORTCUT_CATEGORY_ORDER,
} from "../lib/shortcuts/shortcutActions";
import { Modal } from "./ui/Modal";

type ShortcutHelpProps = {
  open: boolean;
  overrides: KeybindingOverrides;
  onClose: () => void;
};

type ShortcutRow = { id: string; keys: string[]; desc: string };

export function ShortcutHelp({
  open,
  overrides,
  onClose,
}: ShortcutHelpProps): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  if (!open) {
    return null;
  }
  return (
    <Modal
      ariaLabel={t("shortcuts.title")}
      title={t("shortcuts.title")}
      size="md"
      onClose={onClose}
    >
      <div className="shortcut-help">
        {SHORTCUT_CATEGORY_ORDER.map((category) => {
          const rows = getShortcutActions(tRenderer)
            .filter((action) => action.category === category)
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
              title={getShortcutCategoryLabels(tRenderer)[category]}
            />
          );
        })}
        <ShortcutHelpSection
          rows={buildFixedShortcuts(t)}
          title={t("shortcuts.navigation")}
        />
        <p className="muted-line modal-note">{t("shortcuts.settingsHint")}</p>
      </div>
    </Modal>
  );
}

function buildFixedShortcuts(t: TFunction<"components">): ShortcutRow[] {
  return [
    {
      id: "nav-horizontal",
      keys: ["←", "→"],
      desc: t("shortcuts.fixed.previousNextPage"),
    },
    {
      id: "nav-vertical",
      keys: ["↑", "↓"],
      desc: t("shortcuts.fixed.previousNextPageCenter"),
    },
    {
      id: "esc",
      keys: ["Esc"],
      desc: t("shortcuts.fixed.escape"),
    },
  ];
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
