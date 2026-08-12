import type { TFunction } from "i18next";
import type { ShortcutActionId } from "../../../../shared/shortcutSettings";

export type ShortcutCategory =
  | "view"
  | "tool"
  | "translate"
  | "inpaint"
  | "edit"
  | "global";

export function getShortcutCategoryLabels(
  t: TFunction<"renderer">,
): Record<ShortcutCategory, string> {
  return {
    view: t("shortcuts.categories.view"),
    tool: t("shortcuts.categories.tool"),
    translate: t("shortcuts.categories.translate"),
    inpaint: t("shortcuts.categories.inpaint"),
    edit: t("shortcuts.categories.edit"),
    global: t("shortcuts.categories.global"),
  };
}

export const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = [
  "view",
  "tool",
  "translate",
  "edit",
  "inpaint",
  "global",
];

export type ShortcutContext = {
  blockingModalOpen: boolean;
  activeModalActionId: ShortcutActionId | null;
  paletteOpen: boolean;
  helpOpen: boolean;
  chapterOpen: boolean;
  editLocked: boolean;
  jobActive: boolean;
  retouchToolActive: boolean;
  blockSelected: boolean;
};

export type ShortcutActionDef = {
  id: ShortcutActionId;
  label: string;
  category: ShortcutCategory;
  defaultCombo: string;
  defaultAlternateCombos?: string[];
  allowInEditable?: boolean;
  enabled?: (context: ShortcutContext) => boolean;
};
