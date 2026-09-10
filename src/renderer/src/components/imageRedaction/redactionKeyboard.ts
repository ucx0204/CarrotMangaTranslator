import type { RedactionPreferences } from "../../../../shared/imageRedactionWorkspace";
export type RedactionKeyAction = "previous" | "next" | "confirm" | "continue" | "defer" | "undo" | "redo" | "fit" | "actual" | "smaller" | "larger" | "delete" | "pan-held" | RedactionPreferences["tool"];

type Key = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; repeat: boolean; isComposing: boolean };
export function redactionKeyAction(event: Key, preferences: RedactionPreferences): RedactionKeyAction | null {
  if (event.isComposing || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
    if (key === "enter" && !event.repeat) return "continue";
    return null;
  }
  if (key === "enter") return event.repeat ? null : event.shiftKey ? "defer" : "confirm";
  if (key === " ") return "pan-held";
  if (key === "arrowleft" || key === "pageup") return "previous";
  if (key === "arrowright" || key === "pagedown") return "next";
  if (key === "delete" || key === "backspace") return "delete";
  if (!preferences.letterShortcuts) return null;
  if (key === preferences.previousKey && key) return "previous";
  if (key === preferences.nextKey && key) return "next";
  const actions: Record<string, RedactionKeyAction> = {
    r: "rectangle", b: "brush", e: "erase", v: "select", h: "pan", f: "fit", "1": "actual", "[": "smaller", "]": "larger",
  };
  return actions[key] ?? null;
}

export function validRedactionNavigationKeys(previous: string, next: string): boolean {
  const reserved = new Set(["r", "b", "e", "v", "h", "f"]);
  return [previous, next].every((key) => key === "" || /^[a-z]$/.test(key) && !reserved.has(key)) && (!previous || previous !== next);
}
