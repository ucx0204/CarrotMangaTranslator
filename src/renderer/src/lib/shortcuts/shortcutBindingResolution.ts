import type { TFunction } from "i18next";
import type {
  KeybindingOverrides,
  ShortcutActionId,
} from "../../../../shared/shortcutSettings";
import { SHORTCUT_ACTIONS } from "./shortcutActions";
import type { ShortcutActionDef } from "./shortcutActionTypes";

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

export function effectiveCombo(
  actionId: ShortcutActionId,
  overrides: KeybindingOverrides,
): string {
  const override = overrides[actionId];
  if (override !== undefined) return override;
  return ACTION_BY_ID.get(actionId)?.defaultCombo ?? "";
}

export function resolveBindings(
  overrides: KeybindingOverrides,
): Map<string, ShortcutActionId> {
  const safeOverrides = sanitizeKeybindingOverrides(overrides);
  const bindings = new Map<string, ShortcutActionId>();
  for (const action of SHORTCUT_ACTIONS) {
    for (const combo of effectiveCombos(action, safeOverrides)) {
      if (!bindings.has(combo)) bindings.set(combo, action.id);
    }
  }
  return bindings;
}

export function effectiveCombosForAction(
  actionId: ShortcutActionId,
  overrides: KeybindingOverrides,
): string[] {
  const action = ACTION_BY_ID.get(actionId);
  return action ? effectiveCombos(action, overrides) : [];
}

export function assignBinding(
  overrides: KeybindingOverrides,
  actionId: ShortcutActionId,
  combo: string,
  t?: TFunction<"renderer">,
): {
  next: KeybindingOverrides;
  conflictingActionId: ShortcutActionId | null;
  conflictingLabel: string | null;
} {
  const conflict = combo
    ? findBindingConflict(overrides, actionId, combo)
    : null;
  if (conflict) {
    return {
      next: overrides,
      conflictingActionId: conflict.id,
      conflictingLabel: t
        ? t(`shortcuts.actions.${conflict.id}`)
        : conflict.label,
    };
  }
  const next: KeybindingOverrides = { ...overrides };
  next[actionId] = combo;
  return {
    next,
    conflictingActionId: null,
    conflictingLabel: null,
  };
}

export function resetBinding(
  overrides: KeybindingOverrides,
  actionId: ShortcutActionId,
): KeybindingOverrides {
  const next: KeybindingOverrides = { ...overrides };
  delete next[actionId];
  return next;
}

export function sanitizeKeybindingOverrides(
  overrides: KeybindingOverrides,
): KeybindingOverrides {
  const next = { ...overrides };
  for (const action of SHORTCUT_ACTIONS) {
    const combo = next[action.id];
    if (!combo) continue;
    if (findBindingConflict(next, action.id, combo)) {
      delete next[action.id];
    }
  }
  return next;
}

function findBindingConflict(
  overrides: KeybindingOverrides,
  actionId: ShortcutActionId,
  combo: string,
): ShortcutActionDef | null {
  return (
    SHORTCUT_ACTIONS.find(
      (action) =>
        action.id !== actionId &&
        effectiveCombos(action, overrides).includes(combo),
    ) ?? null
  );
}

function effectiveCombos(
  action: ShortcutActionDef,
  overrides: KeybindingOverrides,
): string[] {
  const override = overrides[action.id];
  if (override !== undefined) {
    if (!override) return [];
    return override === action.defaultCombo
      ? [override, ...(action.defaultAlternateCombos ?? [])].filter(Boolean)
      : [override];
  }
  return [action.defaultCombo, ...(action.defaultAlternateCombos ?? [])].filter(
    Boolean,
  );
}
