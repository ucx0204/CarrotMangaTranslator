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
import { clampFontSizePx } from "../../../shared/blockFormatValues";
