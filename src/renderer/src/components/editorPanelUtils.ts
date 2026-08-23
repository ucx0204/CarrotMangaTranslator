export type EditorPanelModel = {
  autoFitText: boolean;
  fontSizePx: number;
  outlineColor: string;
  renderDirection: "horizontal" | "vertical";
};

export function resolveColor(
  value: string | undefined,
  fallback: string,
): string {
  const text = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

export function clampFontSize(value: number): number {
  return clampFontSizePx(value);
}

export function readStoredEditorTab(): EditorTabId {
  try {
    const stored = window.localStorage.getItem(EDITOR_TAB_STORAGE_KEY);
    return EDITOR_TABS.find((tab) => tab === stored) ?? "text";
  } catch (error) {
    console.warn("Editor tab state read failed", error);
    return "text";
  }
}

export function storeEditorTab(tab: EditorTabId): void {
  try {
    window.localStorage.setItem(EDITOR_TAB_STORAGE_KEY, tab);
  } catch (error) {
    console.warn("Editor tab state write failed", error);
  }
}
import { clampFontSizePx } from "../../../shared/blockFormatValues";
import type { EditorTabId } from "./EditorPanelChrome";

const EDITOR_TABS: EditorTabId[] = ["text", "layout", "format"];
const EDITOR_TAB_STORAGE_KEY = "editor.activeTab.v1";
