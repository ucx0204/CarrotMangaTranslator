import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { TFunction } from "i18next";

export const BLOCK_MODE_OPTIONS: { id: AnalysisBlockMode; label: string }[] = [
  { id: "auto", label: "자동 생성" },
  { id: "keep", label: "기존 블록 유지" },
];

export function getBlockModeOptions(
  t: TFunction<"renderer">,
): { id: AnalysisBlockMode; label: string }[] {
  return [
    { id: "auto", label: t("blockMode.auto") },
    { id: "keep", label: t("blockMode.keep") },
  ];
}
