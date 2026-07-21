// @ts-check
const { totalmem } = require("node:os");

const GEMMA_UNIFIED_MEMORY_REQUIREMENTS_MB = Object.freeze({
  minimum12b: 16 * 1024,
  economy26b: 24 * 1024,
  full31b: 32 * 1024,
});

/**
 * @param {Record<string, any>} [options]
 * @param {{ platform?: string; arch?: string; totalMemoryMb?: number }} [system]
 */
function evaluateGemmaUnifiedMemoryPolicy(options = {}, system = {}) {
  const platform = system.platform || process.platform;
  const arch = system.arch || process.arch;
  const profile = String(options.llamaRuntimeProfile || "")
    .trim()
    .toLowerCase();
  const mode = normalizeGemmaVramMode(options.gemmaVramMode);
  const requiredMemoryMb = GEMMA_UNIFIED_MEMORY_REQUIREMENTS_MB[mode];
  if (
    platform !== "darwin" ||
    arch !== "arm64" ||
    !["metal", "apple", "apple-metal", "mps"].includes(profile)
  ) {
    return {
      applies: false,
      allowed: true,
      mode,
      requiredMemoryMb,
      availableMemoryMb: null,
      shortageMb: 0,
      unsafeOverride: false,
    };
  }
  const availableMemoryMb = Math.max(
    0,
    Math.round(
      Number.isFinite(system.totalMemoryMb)
        ? Number(system.totalMemoryMb)
        : totalmem() / 1024 / 1024,
    ),
  );
  const shortageMb = Math.max(0, requiredMemoryMb - availableMemoryMb);
  const unsafeOverride = options.allowUnsafeUnifiedMemory === true;
  return {
    applies: true,
    allowed: shortageMb === 0 || unsafeOverride,
    mode,
    requiredMemoryMb,
    availableMemoryMb,
    shortageMb,
    unsafeOverride: shortageMb > 0 && unsafeOverride,
  };
}

/** @param {Record<string, any>} [options] */
function assertGemmaUnifiedMemoryPolicy(options = {}) {
  const evaluation = evaluateGemmaUnifiedMemoryPolicy(options);
  if (evaluation.allowed) return evaluation;
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(
      "선택한 Gemma 모델에 권장되는 Apple 통합 메모리가 부족합니다. 메모리 부족 위험을 명시적으로 확인한 뒤에만 강제 실행할 수 있습니다.",
    )
  );
  Object.assign(error, {
    code: "MGT_MAC_UNIFIED_MEMORY_CONFIRMATION_REQUIRED",
    gemmaVramMode: evaluation.mode,
    availableUnifiedMemoryMb: evaluation.availableMemoryMb,
    requiredUnifiedMemoryMb: evaluation.requiredMemoryMb,
    shortageMb: evaluation.shortageMb,
    requiresExplicitAlphaConfirmation: true,
    hint: "설정에서 메모리 부족 위험을 확인하거나 더 작은 Gemma 모드를 선택하세요 (16GB=12B, 24GB=26B, 32GB+=31B+DFlash).",
  });
  throw error;
}

/** @param {unknown} value */
function normalizeGemmaVramMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["full31b", "full", "31b"].includes(normalized)) return "full31b";
  if (["economy26b", "economy", "26b"].includes(normalized))
    return "economy26b";
  return "minimum12b";
}

module.exports = {
  GEMMA_UNIFIED_MEMORY_REQUIREMENTS_MB,
  assertGemmaUnifiedMemoryPolicy,
  evaluateGemmaUnifiedMemoryPolicy,
};
