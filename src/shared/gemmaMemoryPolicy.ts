import type { GemmaVramMode } from "./settingsTypes";

const GEMMA_UNIFIED_MEMORY_REQUIREMENTS_MB: Record<GemmaVramMode, number> = {
  minimum12b: 16 * 1024,
  economy26b: 24 * 1024,
  full31b: 32 * 1024,
};

export const GEMMA_MODEL_DOWNLOAD_BYTES: Record<GemmaVramMode, number> = {
  // Model + vision projector. 31B also includes the DFlash draft model.
  minimum12b: 7_556_000_000,
  economy26b: 13_028_000_000,
  full31b: 15_796_000_000,
};

export type GemmaUnifiedMemoryEvaluation = {
  allowed: boolean;
  requiresExplicitAlphaConfirmation: boolean;
  requiredMemoryMb: number;
  availableMemoryMb: number;
  shortageMb: number;
};

export function evaluateGemmaUnifiedMemory(
  mode: GemmaVramMode,
  availableMemoryMb: number,
  allowUnsafeUnifiedMemory = false,
): GemmaUnifiedMemoryEvaluation {
  const requiredMemoryMb = GEMMA_UNIFIED_MEMORY_REQUIREMENTS_MB[mode];
  const normalizedAvailable = Number.isFinite(availableMemoryMb)
    ? Math.max(0, Math.round(availableMemoryMb))
    : 0;
  const shortageMb = Math.max(0, requiredMemoryMb - normalizedAvailable);
  const requiresExplicitAlphaConfirmation = shortageMb > 0;
  return {
    allowed:
      !requiresExplicitAlphaConfirmation || allowUnsafeUnifiedMemory === true,
    requiresExplicitAlphaConfirmation,
    requiredMemoryMb,
    availableMemoryMb: normalizedAvailable,
    shortageMb,
  };
}

export function resolveRecommendedGemmaVramModeForUnifiedMemory(
  availableMemoryMb: number,
): GemmaVramMode | null {
  if (availableMemoryMb >= GEMMA_UNIFIED_MEMORY_REQUIREMENTS_MB.full31b) {
    return "full31b";
  }
  if (availableMemoryMb >= GEMMA_UNIFIED_MEMORY_REQUIREMENTS_MB.economy26b) {
    return "economy26b";
  }
  if (availableMemoryMb >= GEMMA_UNIFIED_MEMORY_REQUIREMENTS_MB.minimum12b) {
    return "minimum12b";
  }
  return null;
}
