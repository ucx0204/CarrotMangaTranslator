/**
 * User overrides keyed by shortcut action id. Structurally identical to (and
 * assignable from) the persisted `AppSettings.keybindings` shape; declared here
 * so the renderer shortcut modules don't couple to the shared settings types.
 * An empty string means the action is intentionally unbound.
 */
export type KeybindingOverrides = Record<string, string>;

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

export const SHORTCUT_CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  view: "표시 / 보기",
  tool: "도구",
  translate: "번역",
  inpaint: "인페인팅",
  edit: "블록 편집",
  global: "전역",
};

export const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = [
  "view",
  "tool",
  "translate",
  "edit",
  "inpaint",
  "global",
];

export type ShortcutActionId =
  | "toggle-block-chrome"
  | "toggle-text-blocks"
  | "toggle-peek-original"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "stage-tool-select"
  | "stage-tool-block"
  | "stage-tool-hand"
  | "toggle-stage-toolbar"
  | "open-translate-options"
  | "translate-pending"
  | "translate-all"
  | "gather-text"
  | "cancel-job"
  | "toggle-inpainting"
  | "history-undo"
  | "history-redo"
  | "retouch-redo"
  | "delete-block"
  | "duplicate-block"
  | "toggle-block-excluded"
  | "toggle-command-palette"
  | "toggle-shortcut-help"
  | "open-settings";

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
  inpaintingMode: boolean;
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
  context.chapterOpen && !context.jobActive && !context.inpaintingMode;

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
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-in",
    label: "이미지 확대",
    category: "view",
    defaultCombo: "ctrl+=",
    defaultAlternateCombos: ["ctrl+numpadadd", "ctrl+add", "ctrl++"],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-out",
    label: "이미지 축소",
    category: "view",
    defaultCombo: "ctrl+-",
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
    enabled: (c) => c.chapterOpen && !c.inpaintingMode,
  },
  {
    id: "stage-tool-block",
    label: "블록 도구 (드래그로 블록 추가)",
    category: "tool",
    defaultCombo: "2",
    enabled: (c) => c.chapterOpen && !c.inpaintingMode,
  },
  {
    id: "stage-tool-hand",
    label: "손바닥 도구 (드래그로 이동)",
    category: "tool",
    defaultCombo: "3",
    enabled: (c) => c.chapterOpen && !c.inpaintingMode,
  },
  {
    id: "toggle-stage-toolbar",
    label: "도구 모음 표시 전환",
    category: "tool",
    defaultCombo: "4",
    enabled: (c) => c.chapterOpen && !c.inpaintingMode,
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
    label: "인페인팅 시작/종료",
    category: "inpaint",
    defaultCombo: "i",
    enabled: (c) => c.inpaintingMode || (c.chapterOpen && !c.jobActive),
  },
  {
    id: "history-undo",
    label: "실행 취소",
    category: "edit",
    defaultCombo: "ctrl+z",
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "history-redo",
    label: "다시 실행",
    category: "edit",
    defaultCombo: "ctrl+shift+z",
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "retouch-redo",
    label: "보정 다시 실행",
    category: "inpaint",
    defaultCombo: "ctrl+y",
    enabled: (c) => c.inpaintingMode,
  },
  {
    id: "delete-block",
    label: "선택한 블록 삭제",
    category: "edit",
    defaultCombo: "delete",
    enabled: (c) => c.blockSelected,
  },
  {
    id: "duplicate-block",
    label: "선택한 블록 복제",
    category: "edit",
    defaultCombo: "ctrl+d",
    enabled: (c) => c.blockSelected,
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
  actionId: string,
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
): { next: KeybindingOverrides; displacedLabel: string | null } {
  const next: KeybindingOverrides = { ...overrides };
  let displacedLabel: string | null = null;
  if (combo) {
    for (const action of SHORTCUT_ACTIONS) {
      if (
        action.id !== actionId &&
        effectiveCombos(action, next).includes(combo)
      ) {
        next[action.id] = "";
        displacedLabel = action.label;
      }
    }
  }
  next[actionId] = combo;
  return { next, displacedLabel };
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
