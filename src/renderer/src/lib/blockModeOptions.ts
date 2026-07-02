import type { AnalysisBlockMode } from "../../../shared/analysisTypes";

export const BLOCK_MODE_OPTIONS: { id: AnalysisBlockMode; label: string }[] = [
  { id: "auto", label: "자동 생성" },
  { id: "keep", label: "기존 블록 유지" },
];
