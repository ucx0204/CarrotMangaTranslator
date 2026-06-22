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
  if (!Number.isFinite(value)) {
    return 24;
  }
  return Math.max(10, Math.min(160, Math.round(value)));
}
