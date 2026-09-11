import type { KeybindingOverrides } from "../../../../shared/shortcutSettings";
import { comboFromEvent } from "../../lib/shortcuts/comboFromEvent";
import {
  resolveBindings,
  sanitizeKeybindingOverrides,
} from "../../lib/shortcuts/shortcutBindingResolution";
import type { RedactionPreferences } from "../../../../shared/imageRedactionWorkspace";
export type RedactionKeyAction =
  | "previous"
  | "next"
  | "confirm"
  | "continue"
  | "undo"
  | "redo"
  | "fit"
  | "actual"
  | "smaller"
  | "larger"
  | "delete"
  | "pan-held"
  | RedactionPreferences["tool"];

type Key = {
  code?: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
};
const inheritedActions = {
  "page-previous": "previous",
  "page-next": "next",
  "history-undo": "undo",
  "history-redo": "redo",
  "zoom-fit-contain": "fit",
  "zoom-actual-size": "actual",
} as const;

/** Reuse common conflict resolution; only dispatch into this editor, never the page behind it. */
export function redactionBindings(
  preferences: RedactionPreferences,
  overrides: KeybindingOverrides = {},
): Map<string, RedactionKeyAction> {
  const safe = sanitizeKeybindingOverrides(overrides);
  const bindings = new Map<string, RedactionKeyAction>([
    [" ", "pan-held"],
    ["delete", "delete"],
    ["backspace", "delete"],
  ]);
  if (preferences.letterShortcuts) {
    for (const [combo, action] of Object.entries({
      r: "rectangle",
      b: "brush",
      e: "erase",
      v: "select",
      h: "pan",
      "[": "smaller",
      "]": "larger",
    } as const))
      bindings.set(combo, action);
    const aliases = [
      ["page-previous", preferences.previousKey, "previous"],
      ["page-next", preferences.nextKey, "next"],
      ["zoom-fit-contain", "f", "fit"],
      ["zoom-actual-size", "1", "actual"],
    ] as const;
    for (const [id, combo, action] of aliases)
      if (safe[id] === undefined && combo) bindings.set(combo, action);
  }
  for (const [combo, id] of resolveBindings(safe)) {
    if (["enter", "ctrl+enter", " "].includes(combo)) continue;
    const action = inheritedActions[id as keyof typeof inheritedActions];
    if (action && (preferences.letterShortcuts || !/^[a-z0-9]$/.test(combo)))
      bindings.set(combo, action);
  }
  return bindings;
}

export function redactionKeyAction(
  event: Key,
  preferences: RedactionPreferences,
  overrides: KeybindingOverrides = {},
): RedactionKeyAction | null {
  if (event.isComposing) return null;
  const combo = comboFromEvent(event);
  // Approval is deliberately not customizable through ordinary navigation settings.
  if (combo === "enter" || combo === "ctrl+enter")
    return event.repeat ? null : combo === "enter" ? "confirm" : "continue";
  return combo
    ? (redactionBindings(preferences, overrides).get(combo) ?? null)
    : null;
}

export function validRedactionNavigationKeys(
  previous: string,
  next: string,
): boolean {
  const reserved = new Set(["r", "b", "e", "v", "h", "f"]);
  return (
    [previous, next].every(
      (key) => key === "" || (/^[a-z]$/.test(key) && !reserved.has(key)),
    ) &&
    (!previous || previous !== next)
  );
}
