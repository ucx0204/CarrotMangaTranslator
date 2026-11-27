import { z } from "zod/v4";

export type ImageEditingUsage = {
  planType: string | null;
  usedPercent: number | null;
  resetsAt: number | null;
  limitReached: boolean;
};

/** Product policy, not a provider entitlement or a count of remaining images. */
export function imageEditingBudget(usage: ImageEditingUsage) {
  const remaining = usage.usedPercent === null ? null : 100 - usage.usedPercent;
  const pro = /^pro(?:_|$)/i.test(usage.planType ?? "");
  const constrained =
    usage.limitReached || (remaining !== null && remaining <= 20);
  const comfortable = remaining !== null && remaining >= (pro ? 30 : 50);
  const generation = constrained
    ? "avoid"
    : comfortable
      ? "complex-only"
      : "local-first";
  return {
    ...usage,
    remainingPercent: remaining,
    usageScope: "codex-account-windows-not-image-count" as const,
    imageQuotaRemaining: null,
    generation,
    maxAttemptsPerRegion: constrained ? 0 : comfortable ? 1 + Number(pro) : 1,
    simpleBackground: "aot-inpainting" as const,
    ordinaryBackground: "qwen-image-2.1" as const,
    complexBackground:
      generation === "complex-only" ? "codex" : "qwen-image-2.1",
    instruction:
      "Explicit user engine/model choices take precedence over these automatic defaults; never silently switch a requested engine. Inspect original pixels to classify each region. Use native solid fill/AOT for simple clean backgrounds, Qwen Image 2.1 for ordinary erasure (FLUX is available as a fallback), and ImageGen for complex reconstruction when the budget allows. local-first means reserve one generation for a visually confirmed local failure; avoid means no automatic generation. Pro receives more headroom, never unlimited generation. Usage is account-wide Codex pressure, NOT an image-generation allowance. Unknown usage is not zero usage. Recheck before another generation batch; quota/rate-limit errors stop generation until reset. Never buy credits or consume a reset automatically. Keep existing per-region cumulative attempt ceilings, source protection and terminal policy-refusal rules. A successful erasure is not visual acceptance.",
  };
}

export const ImageEditingBudgetSchema = z
  .object({
    observedAt: z.number(),
    planType: z.string().nullable(),
    usedPercent: z.number().min(0).max(100).nullable(),
    resetsAt: z.number().nullable(),
    limitReached: z.boolean(),
    remainingPercent: z.number().min(0).max(100).nullable(),
    usageScope: z.literal("codex-account-windows-not-image-count"),
    imageQuotaRemaining: z.null(),
    generation: z.enum(["avoid", "complex-only", "local-first"]),
    maxAttemptsPerRegion: z.number().int().min(0).max(2),
    simpleBackground: z.literal("aot-inpainting"),
    ordinaryBackground: z.literal("qwen-image-2.1"),
    complexBackground: z.enum(["codex", "qwen-image-2.1"]),
    instruction: z.string(),
  })
  .strict();
