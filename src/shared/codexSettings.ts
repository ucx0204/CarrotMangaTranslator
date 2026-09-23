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

/** GPT-5.6+ request controllers; the built-in image backend is managed by Codex. */
export function isCodexImageModel(model: unknown): model is string {
  if (typeof model !== "string") return false;
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-[a-z0-9]+)*$/.exec(model);
  if (!version) return false;
  const major = Number(version[1]);
  return major > 5 || (major === 5 && Number(version[2] ?? 0) >= 6);
}

export const CODEX_IMAGE_GENERATION_MODELS = [
  "auto",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;

export type CodexImageGenerationModel =
  (typeof CODEX_IMAGE_GENERATION_MODELS)[number];
