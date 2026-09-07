export const CODEX_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** ImageGen uses GPT Image 2; these are the separately selected request controllers. */
export const CODEX_IMAGE_MODELS = ["gpt-6-astra", "gpt-5.6-sol"] as const;
