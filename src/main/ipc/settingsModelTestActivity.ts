import type { AppOperationActivityUpdate } from "../appOperationRegistry";
import type { SendModelTestProgress } from "./settingsModelTestProgress";

export function toModelTestActivity(
  progress: Parameters<SendModelTestProgress>[0],
): AppOperationActivityUpdate {
  const phase = resolveModelTestOperationPhase(progress.phase);
  if (
    Number.isFinite(progress.progressBytes) &&
    Number.isFinite(progress.progressTotalBytes) &&
    (progress.progressTotalBytes ?? 0) > 0
  ) {
    return {
      phase,
      progressCurrent: progress.progressBytes,
      progressTotal: progress.progressTotalBytes,
      progressUnit: "bytes",
    };
  }
  if (Number.isFinite(progress.progressPercent)) {
    return {
      phase,
      progressCurrent: Math.max(
        0,
        Math.min(100, (progress.progressPercent ?? 0) * 100),
      ),
      progressTotal: 100,
      progressUnit: "percent",
    };
  }
  return { phase };
}

function resolveModelTestOperationPhase(
  phase: Parameters<SendModelTestProgress>[0]["phase"],
): AppOperationActivityUpdate["phase"] {
  if (phase === "model_downloading") return "model-test-downloading";
  if (phase === "ready" || phase === "done") {
    return "model-test-checking";
  }
  return "model-test-preparing";
}
