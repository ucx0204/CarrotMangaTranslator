// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { onProgress?: ((progress: Record<string, unknown>) => void) | null } & Record<string, any>} CalibrationOptions */
const {
  measureNvidiaFreeVramMiB,
  probeMtpServerPerformance,
  shouldCalibrateMtpFit,
} = require("../model/mtp-fit-calibration.cjs");

const VRAM_THROTTLE_MESSAGE =
  "Gemma가 VRAM 부족으로 너무 느려 작업을 중단했습니다. 설정에서 컨텍스트 길이와 최대 출력 토큰을 낮춰 주세요.";

const DEFAULT_CALIBRATION_DEPENDENCIES = Object.freeze({
  measureNvidiaFreeVramMiB,
  probeMtpServerPerformance,
  shouldCalibrateMtpFit,
});

/**
 * Measure the real MTP context without changing the user's configured context,
 * output limit, or free-VRAM target. Abort when the short decode probe shows
 * that Windows has entered the unusably slow low-VRAM path.
 *
 * @param {string} baseUrl
 * @param {CalibrationOptions} options
 * @param {typeof DEFAULT_CALIBRATION_DEPENDENCIES} [dependencies]
 */
async function calibrateMtpFitServer(
  baseUrl,
  options,
  dependencies = DEFAULT_CALIBRATION_DEPENDENCIES,
) {
  const requestedFitTargetMiB = Number(options.fitTargetMb ?? 0);
  const inspection = await inspectMtpFitCalibration(
    baseUrl,
    options,
    requestedFitTargetMiB,
    dependencies,
  );
  if (!inspection.probe.healthy) {
    throw emitVramThrottleError(options, {
      requestedFitTargetMiB,
      effectiveFitTargetMiB: requestedFitTargetMiB,
      observedFreeMiB: inspection.observedFreeMiB,
      predictedTokensPerSecond: inspection.probe.predictedPerSecond,
      probeTimedOut: inspection.probe.timedOut === true,
    });
  }
  return {
    requestedFitTargetMiB,
    effectiveFitTargetMiB: requestedFitTargetMiB,
    observedFreeMiB: inspection.observedFreeMiB,
  };
}

/**
 * @param {string} baseUrl
 * @param {CalibrationOptions} options
 * @param {number} requestedFitTargetMiB
 * @param {typeof DEFAULT_CALIBRATION_DEPENDENCIES} [dependencies]
 */
async function inspectMtpFitCalibration(
  baseUrl,
  options,
  requestedFitTargetMiB,
  dependencies = DEFAULT_CALIBRATION_DEPENDENCIES,
) {
  if (!dependencies.shouldCalibrateMtpFit(options)) {
    return disabledCalibration(requestedFitTargetMiB);
  }
  emitMtpFitMeasurement(options, requestedFitTargetMiB);
  const probe = await dependencies.probeMtpServerPerformance(baseUrl, options);
  const idleObservedFreeMiB =
    await dependencies.measureNvidiaFreeVramMiB(options);
  const observedFreeMiB = minimumFiniteNumber([
    probe.minimumFreeMiB,
    idleObservedFreeMiB,
  ]);
  return {
    requestedFitTargetMiB,
    observedFreeMiB,
    probe,
  };
}

/** @param {number} requestedFitTargetMiB */
function disabledCalibration(requestedFitTargetMiB) {
  return {
    requestedFitTargetMiB,
    observedFreeMiB: null,
    probe: {
      wallMs: 0,
      minimumFreeMiB: null,
      predictedTokens: null,
      predictedPerSecond: null,
      healthy: true,
      timedOut: false,
    },
  };
}

/** @param {CalibrationOptions} options @param {number} requestedFitTargetMiB */
function emitMtpFitMeasurement(options, requestedFitTargetMiB) {
  emitCalibrationProgress(
    options,
    "booting",
    "MTP VRAM 여유 측정 중",
    "실제 MTP 이미지 입력 중 남은 VRAM과 짧은 디코드 속도를 확인합니다.",
    {
      progressMode: "indeterminate",
      installLogLine: `MTP fit 실측을 시작합니다 (요청 ${requestedFitTargetMiB} MiB).`,
    },
  );
}

/** @param {CalibrationOptions} options @param {Record<string, unknown>} detail */
function emitVramThrottleError(options, detail) {
  emitCalibrationProgress(
    options,
    "booting",
    "Gemma VRAM 부족",
    VRAM_THROTTLE_MESSAGE,
    {
      progressMode: "log-only",
      installLogLine: VRAM_THROTTLE_MESSAGE,
      notification: { variant: "error", message: VRAM_THROTTLE_MESSAGE },
    },
  );
  return createCalibrationError(VRAM_THROTTLE_MESSAGE, detail);
}

/** @param {string} message @param {Record<string, unknown>} detail */
function createCalibrationError(message, detail) {
  return Object.assign(new Error(message), detail);
}

/** @param {CalibrationOptions} options @param {string} phase @param {string} progressText @param {string} detail @param {Record<string, unknown>} progress */
function emitCalibrationProgress(
  options,
  phase,
  progressText,
  detail,
  progress,
) {
  if (typeof options.onProgress !== "function") return;
  try {
    options.onProgress({ phase, progressText, detail, ...progress });
  } catch (_error) {
    // error-policy-allow: observer failures must never interrupt translation.
  }
}

/** @param {unknown[]} values */
function minimumFiniteNumber(values) {
  const finiteValues = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return finiteValues.length ? Math.min(...finiteValues) : null;
}

module.exports = { VRAM_THROTTLE_MESSAGE, calibrateMtpFitServer };
