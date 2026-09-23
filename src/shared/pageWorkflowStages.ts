export const PAGE_WORKFLOW_STAGES = [
  "detect",
  "ocr",
  "source-rules",
  "translate",
  "translation-rules",
  "typography",
  "format-rules",
  "erase",
  "layout",
  "review",
] as const;
export type PageWorkflowStage = (typeof PAGE_WORKFLOW_STAGES)[number];
export const PAGE_WORKFLOW_STAGE_LABELS: Record<PageWorkflowStage, string> = {
  detect: "블록 검출",
  ocr: "원문 읽기 · OCR",
  "source-rules": "원문 일괄 편집",
  translate: "번역",
  "translation-rules": "번역문 일괄 편집",
  typography: "자동 서식",
  "format-rules": "최종 일괄 편집",
  erase: "원문 제거",
  layout: "말풍선·줄 배치",
  review: "자동 검수",
};
