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
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
};
export function redactionKeyAction(
  event: Key,
  preferences: RedactionPreferences,
): RedactionKeyAction | null {
  if (event.isComposing || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) return modifiedKeyAction(event, key);
  if (key === "enter") return enterKeyAction(event);
  const fixed: Record<string, RedactionKeyAction> = {
    " ": "pan-held",
    arrowleft: "previous",
    pageup: "previous",
    arrowright: "next",
    pagedown: "next",
    delete: "delete",
    backspace: "delete",
  };
  if (fixed[key]) return fixed[key];
  return preferences.letterShortcuts ? letterKeyAction(key, preferences) : null;
}
function modifiedKeyAction(event: Key, key: string): RedactionKeyAction | null {
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y") return "redo";
  return key === "enter" && !event.repeat ? "continue" : null;
}
function enterKeyAction(event: Key): RedactionKeyAction | null {
  if (event.repeat) return null;
  return event.shiftKey ? null : "confirm";
}
function letterKeyAction(
  key: string,
  preferences: RedactionPreferences,
): RedactionKeyAction | null {
  if (key && key === preferences.previousKey) return "previous";
  if (key && key === preferences.nextKey) return "next";
  const actions: Record<string, RedactionKeyAction> = {
    r: "rectangle",
    b: "brush",
    e: "erase",
    v: "select",
    h: "pan",
    f: "fit",
    "1": "actual",
    "[": "smaller",
    "]": "larger",
  };
  return actions[key] ?? null;
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
