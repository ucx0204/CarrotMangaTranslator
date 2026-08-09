export const SHORTCUT_ACTION_IDS = [
  "toggle-block-chrome",
  "toggle-text-blocks",
  "toggle-peek-original",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "page-previous",
  "page-next",
  "stage-tool-select",
  "stage-tool-block",
  "stage-tool-hand",
  "toggle-stage-toolbar",
  "open-translate-options",
  "translate-pending",
  "translate-all",
  "gather-text",
  "cancel-job",
  "toggle-inpainting",
  "block-previous",
  "block-next",
  "history-undo",
  "history-redo",
  "delete-block",
  "duplicate-block",
  "toggle-block-excluded",
  "toggle-command-palette",
  "toggle-shortcut-help",
  "open-settings",
] as const;

export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number];

/**
 * Persisted user overrides. Missing actions use their built-in shortcut and an
 * empty string explicitly unbinds an action.
 */
export type KeybindingOverrides = Partial<Record<ShortcutActionId, string>>;

export const MAX_KEYBINDING_COMBO_LENGTH = 60;

const SHORTCUT_ACTION_ID_SET: ReadonlySet<string> = new Set(
  SHORTCUT_ACTION_IDS,
);
const MODIFIER_TOKENS = ["ctrl", "alt", "shift"] as const;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function isShortcutActionId(value: string): value is ShortcutActionId {
  return SHORTCUT_ACTION_ID_SET.has(value);
}

/**
 * Checks the canonical format emitted by the renderer's keyboard-event
 * normalizer. Modifiers must appear once and in ctrl/alt/shift order.
 */
export function isCanonicalKeybindingCombo(value: string): boolean {
  if (value === "") {
    return true;
  }
  if (
    value.length > MAX_KEYBINDING_COMBO_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    value !== value.toLowerCase()
  ) {
    return false;
  }

  let mainKey = value;
  for (const modifier of MODIFIER_TOKENS) {
    const prefix = `${modifier}+`;
    if (mainKey.startsWith(prefix)) {
      mainKey = mainKey.slice(prefix.length);
    }
  }

  return (
    mainKey.length > 0 &&
    !MODIFIER_TOKENS.some((modifier) => modifier === mainKey) &&
    (mainKey === " " || !/\s/.test(mainKey)) &&
    (mainKey === "+" || !mainKey.includes("+"))
  );
}

/**
 * Stored settings are a migration boundary: legacy casing is normalized while
 * unknown action ids and malformed values are deliberately discarded. A
 * non-object value returns null so callers can restore their defaults.
 */
export function normalizeStoredKeybindingOverrides(
  value: unknown,
): KeybindingOverrides | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const normalized: KeybindingOverrides = {};
  for (const [actionId, rawCombo] of Object.entries(value)) {
    if (!isShortcutActionId(actionId) || typeof rawCombo !== "string") {
      continue;
    }
    const combo = rawCombo.toLowerCase();
    if (isCanonicalKeybindingCombo(combo)) {
      normalized[actionId] = combo;
    }
  }
  return normalized;
}
