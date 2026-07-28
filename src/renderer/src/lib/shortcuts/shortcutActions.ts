import type { TFunction } from "i18next";
import type {
  KeybindingOverrides,
  ShortcutActionId,
} from "../../../../shared/shortcutSettings";

/**
 * Single source of truth for the app's customizable keyboard shortcuts.
 *
 * Each action has a built-in `defaultCombo`; users may override it via settings
 * (`AppSettings.keybindings`, an action-id → combo map). An override of `""`
 * means the action is intentionally unbound. The combo string format is the one
 * produced by `comboFromEvent` (e.g. "ctrl+shift+b", "delete", "1", "?").
 *
 * Page navigation (arrows / wheel) and the in-modal Escape key are intentionally
 * NOT registered here — they keep their dedicated handlers and stay fixed.
 */

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

/**
 * Runtime context consulted by the dispatcher to decide whether an action may
 * fire. `editableTarget` is intentionally absent — it depends on the event
 * target and is computed per keystroke inside the dispatcher.
 */
export type ShortcutContext = {
  blockingModalOpen: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  chapterOpen: boolean;
  jobActive: boolean;
  retouchToolActive: boolean;
  blockSelected: boolean;
};

export type ShortcutActionDef = {
  id: ShortcutActionId;
  label: string;
  category: ShortcutCategory;
  /** Built-in combo; "" means unbound by default. */
  defaultCombo: string;
  /** Extra built-in combos accepted while the action has no user override. */
  defaultAlternateCombos?: string[];
  /** When true, the action still fires while a text input is focused. */
  allowInEditable?: boolean;
  /** Contextual availability beyond the global guards. */
  enabled?: (context: ShortcutContext) => boolean;
};

const canTranslate = (context: ShortcutContext): boolean =>
  context.chapterOpen && !context.jobActive;

export const SHORTCUT_ACTIONS: ShortcutActionDef[] = [
  {
    id: "toggle-block-chrome",
    label: "배경/테두리 표시 전환",
    category: "view",
    defaultCombo: "b",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "toggle-text-blocks",
    label: "블록 표시 전환",
    category: "view",
    defaultCombo: "v",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "toggle-peek-original",
    label: "원본 미리보기 전환",
    category: "view",
    defaultCombo: "o",
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "zoom-in",
    label: "이미지 확대",
    category: "view",
    defaultCombo: "ctrl+=",
    defaultAlternateCombos: [
      "ctrl+numpadadd",
      "ctrl+add",
      "ctrl++",
      "ctrl+wheelup",
    ],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-out",
    label: "이미지 축소",
    category: "view",
    defaultCombo: "ctrl+-",
    defaultAlternateCombos: ["ctrl+wheeldown"],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-reset",
    label: "확대 초기화",
    category: "view",
    defaultCombo: "ctrl+0",
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "stage-tool-select",
    label: "선택 도구",
    category: "tool",
    defaultCombo: "1",
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "stage-tool-block",
    label: "블록 도구 (드래그로 블록 추가)",
    category: "tool",
    defaultCombo: "2",
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "stage-tool-hand",
    label: "손바닥 도구 (드래그로 이동)",
    category: "tool",
    defaultCombo: "3",
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "toggle-stage-toolbar",
    label: "도구 모음 표시 전환",
    category: "tool",
    defaultCombo: "4",
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "open-translate-options",
    label: "번역 옵션 열기",
    category: "translate",
    defaultCombo: "t",
    enabled: canTranslate,
  },
  {
    id: "translate-pending",
    label: "이어서 번역 (남은 페이지)",
    category: "translate",
    defaultCombo: "shift+t",
    enabled: canTranslate,
  },
  {
    id: "translate-all",
    label: "전체 다시 번역",
    category: "translate",
    defaultCombo: "",
    enabled: canTranslate,
  },
  {
    id: "gather-text",
    label: "텍스트 모아보기",
    category: "translate",
    defaultCombo: "g",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "cancel-job",
    label: "작업 취소",
    category: "translate",
    defaultCombo: "",
    enabled: (c) => c.jobActive,
  },
  {
    id: "toggle-inpainting",
    label: "현재 페이지 자동 지우기",
    category: "inpaint",
    defaultCombo: "i",
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "history-undo",
    label: "실행 취소",
    category: "edit",
    defaultCombo: "ctrl+z",
    allowInEditable: true,
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "history-redo",
    label: "다시 실행",
    category: "edit",
    defaultCombo: "ctrl+shift+z",
    defaultAlternateCombos: ["ctrl+y"],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "delete-block",
    label: "선택한 블록 삭제",
    category: "edit",
    defaultCombo: "delete",
    enabled: (c) => c.blockSelected && !c.jobActive,
  },
  {
    id: "duplicate-block",
    label: "선택한 블록 복제",
    category: "edit",
    defaultCombo: "ctrl+d",
    enabled: (c) => c.blockSelected && !c.jobActive,
  },
  {
    id: "toggle-block-excluded",
    label: "블록 인페인팅 제외 전환",
    category: "edit",
    defaultCombo: "x",
    enabled: (c) => c.blockSelected && !c.jobActive,
  },
  {
    id: "toggle-command-palette",
    label: "명령 팔레트",
    category: "global",
    defaultCombo: "ctrl+k",
    allowInEditable: true,
  },
  {
    id: "toggle-shortcut-help",
    label: "단축키 도움말",
    category: "global",
    defaultCombo: "?",
  },
  {
    id: "open-settings",
    label: "설정 열기",
    category: "global",
    defaultCombo: "ctrl+,",
  },
];

export function getShortcutActions(
  t: TFunction<"renderer">,
): ShortcutActionDef[] {
  return SHORTCUT_ACTIONS.map((action) => ({
    ...action,
    label: t(`shortcuts.actions.${action.id}`),
  }));
}

const ACTION_BY_ID = new Map<string, ShortcutActionDef>(
  SHORTCUT_ACTIONS.map((action) => [action.id, action]),
);

export function getShortcutAction(
  actionId: string,
): ShortcutActionDef | undefined {
  return ACTION_BY_ID.get(actionId);
}

/**
 * Effective combo for an action given the user's overrides. Returns "" when the
 * action is unbound (either by default or via an explicit empty override).
 */
export function effectiveCombo(
  actionId: ShortcutActionId,
  overrides: KeybindingOverrides,
): string {
  const override = overrides[actionId];
  if (override !== undefined) {
    return override;
  }
  return ACTION_BY_ID.get(actionId)?.defaultCombo ?? "";
}

/** Build a combo → actionId lookup from the user's overrides. */
export function resolveBindings(
  overrides: KeybindingOverrides,
): Map<string, ShortcutActionId> {
  const bindings = new Map<string, ShortcutActionId>();
  for (const action of SHORTCUT_ACTIONS) {
    for (const combo of effectiveCombos(action, overrides)) {
      bindings.set(combo, action.id);
    }
  }
  return bindings;
}

/**
 * Assign `combo` to `actionId`, unbinding any other action that currently
 * resolves to the same combo so a binding is never ambiguous.
 */
export function assignBinding(
  overrides: KeybindingOverrides,
  actionId: ShortcutActionId,
  combo: string,
  t?: TFunction<"renderer">,
): {
  next: KeybindingOverrides;
  displacedActionId: ShortcutActionId | null;
  displacedLabel: string | null;
} {
  const next: KeybindingOverrides = { ...overrides };
  let displacedActionId: ShortcutActionId | null = null;
  let displacedLabel: string | null = null;
  if (combo) {
    for (const action of SHORTCUT_ACTIONS) {
      if (
        action.id !== actionId &&
        effectiveCombos(action, next).includes(combo)
      ) {
        next[action.id] = "";
        displacedActionId = action.id;
        displacedLabel = t ? t(`shortcuts.actions.${action.id}`) : action.label;
      }
    }
  }
  next[actionId] = combo;
  return { next, displacedActionId, displacedLabel };
}

/** Reset an action to its built-in default by dropping any override. */
export function resetBinding(
  overrides: KeybindingOverrides,
  actionId: ShortcutActionId,
): KeybindingOverrides {
  const next: KeybindingOverrides = { ...overrides };
  delete next[actionId];
  return next;
}

function effectiveCombos(
  action: ShortcutActionDef,
  overrides: KeybindingOverrides,
): string[] {
  const override = overrides[action.id];
  if (override !== undefined) {
    if (!override) {
      return [];
    }
    if (override === action.defaultCombo) {
      return [override, ...(action.defaultAlternateCombos ?? [])].filter(
        Boolean,
      );
    }
    return [override];
  }
  return [action.defaultCombo, ...(action.defaultAlternateCombos ?? [])].filter(
    Boolean,
  );
}
