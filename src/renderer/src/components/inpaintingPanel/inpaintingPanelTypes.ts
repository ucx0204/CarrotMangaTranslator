export type FlowStep = "auto" | "retouch" | "export";

export const STEP_ORDER: FlowStep[] = ["auto", "retouch", "export"];

export const STEP_LABELS: Record<FlowStep, string> = {
  auto: "자동",
  retouch: "보정",
  export: "출력",
};
