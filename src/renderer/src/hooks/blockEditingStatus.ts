import type { TFunction } from "i18next";

export type FormatApplyScope = "selection" | "page" | "chapter";

export function resolveFormatApplyStatus(
  scope: FormatApplyScope,
  selectionCount: number,
  t: TFunction<"renderer">,
): string {
  if (scope === "selection") {
    return t("blockEditing.formatAppliedSelection", {
      count: selectionCount,
    });
  }
  if (scope === "page") return t("blockEditing.formatAppliedPage");
  return t("blockEditing.formatAppliedChapter");
}
