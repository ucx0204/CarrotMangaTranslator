import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { TFunction } from "i18next";

export function getBlockModeOptions(
  t: TFunction<"renderer">,
): { id: AnalysisBlockMode; label: string }[] {
  return [
    { id: "auto", label: t("blockMode.auto") },
    { id: "keep", label: t("blockMode.keep") },
  ];
}
