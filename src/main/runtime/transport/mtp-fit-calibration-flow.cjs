// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { onProgress?: ((progress: Record<string, unknown>) => void) | null } & Record<string, any>} CalibrationOptions */
const {
  calculateMtpFitCorrection,
  measureNvidiaFreeVramMiB,
  probeMtpServerPerformance,
  shouldCalibrateMtpFit,
} = require("../model/mtp-fit-calibration.cjs");

const DEFAULT_CALIBRATION_DEPENDENCIES = Object.freeze({
  calculateMtpFitCorrection,
  measureNvidiaFreeVramMiB,
  probeMtpServerPerformance,
  shouldCalibrateMtpFit,
});

/**
 * Measure the real multimodal MTP context and, when necessary, restart once
 * with a runtime-only fit target. The persisted user setting is never changed.
 *
 * @param {string} baseUrl
 * @param {CalibrationOptions} options
 * @param {(calibratedOptions: CalibrationOptions) => Promise<void>} restart
 * @param {typeof DEFAULT_CALIBRATION_DEPENDENCIES} [dependencies]
 */
async function calibrateMtpFitServer(
  baseUrl,
  options,
  restart,
  dependencies = DEFAULT_CALIBRATION_DEPENDENCIES,
) {
  const calibration = await inspectMtpFitCalibration(
    baseUrl,
    options,
    {},
    dependencies,
  );
  if (!calibration.restartRequired) return;
  emitMtpFitRestart(options, calibration);
  const calibratedOptions = {
    ...options,
    fitTargetMb: calibration.effectiveFitTargetMiB,
  };
  await restart(calibratedOptions);
  const verified = await inspectMtpFitCalibration(
    baseUrl,
    calibratedOptions,
    {
      requestedFitTargetMiB: calibration.requestedFitTargetMiB,
      allowRestart: false,
    },
    dependencies,
  );
  assertMtpFitProbeHealthy(calibration, verified);
  emitMtpFitVerified(options, calibration, verified);
}

/**
 * @param {string} baseUrl
 * @param {CalibrationOptions} options
 * @param {{ requestedFitTargetMiB?: number; allowRestart?: boolean }} [control]
 * @param {typeof DEFAULT_CALIBRATION_DEPENDENCIES} [dependencies]
 */
async function inspectMtpFitCalibration(
  baseUrl,
  options,
  control = {},
  dependencies = DEFAULT_CALIBRATION_DEPENDENCIES,
) {
  const requestedFitTargetMiB = Number(
    control.requestedFitTargetMiB ?? options.fitTargetMb ?? 0,
  );
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
  const correction = resolveFitCorrection(
    requestedFitTargetMiB,
    observedFreeMiB,
    options,
    dependencies,
  );
  return {
    ...correction,
    observedFreeMiB,
    probe,
    restartRequired:
      control.allowRestart !== false &&
      (correction.correctionMiB > 0 || !probe.healthy),
  };
}

/** @param {number} requestedFitTargetMiB */
function disabledCalibration(requestedFitTargetMiB) {
  return {
    requestedFitTargetMiB,
    observedFreeMiB: null,
    effectiveFitTargetMiB: requestedFitTargetMiB,
    correctionMiB: 0,
    restartRequired: false,
    probe: { healthy: true, predictedPerSecond: null },
  };
}

/** @param {number} requestedFitTargetMiB @param {number | null} observedFreeMiB @param {CalibrationOptions} options @param {typeof DEFAULT_CALIBRATION_DEPENDENCIES} dependencies */
function resolveFitCorrection(
  requestedFitTargetMiB,
  observedFreeMiB,
  options,
  dependencies,
) {
  if (observedFreeMiB === null) {
    return {
      requestedFitTargetMiB,
      observedFreeMiB: null,
      effectiveFitTargetMiB: Number(options.fitTargetMb ?? 0),
      correctionMiB: 0,
    };
  }
  return dependencies.calculateMtpFitCorrection({
    requestedFitTargetMiB,
    observedFreeMiB,
  });
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

/** @param {CalibrationOptions} options @param {Awaited<ReturnType<typeof inspectMtpFitCalibration>>} calibration */
function emitMtpFitRestart(options, calibration) {
  const hasCorrection = calibration.correctionMiB > 0;
  const message = hasCorrection
    ? `MTP fit 보정: ${calibration.requestedFitTargetMiB} → ${calibration.effectiveFitTargetMiB} MiB (+${calibration.correctionMiB} MiB, 실측 여유 ${calibration.observedFreeMiB} MiB)`
    : `MTP 서버 속도 이상 감지 (${formatTokensPerSecond(calibration.probe.predictedPerSecond)}), 동일 설정으로 한 번 재시작합니다.`;
  emitCalibrationProgress(
    options,
    "booting",
    hasCorrection ? "MTP VRAM 여유 자동 보정" : "MTP 서버 성능 복구",
    message,
    {
      progressMode: "indeterminate",
      installLogLine: message,
      notification: { variant: "info", message },
    },
  );
}

/** @param {Awaited<ReturnType<typeof inspectMtpFitCalibration>>} calibration @param {Awaited<ReturnType<typeof inspectMtpFitCalibration>>} verified */
function assertMtpFitProbeHealthy(calibration, verified) {
  if (verified.probe.healthy) return;
  throw createCalibrationError(
    "MTP 서버가 VRAM 보정 후에도 비정상적으로 느립니다.",
    {
      requestedFitTargetMiB: calibration.requestedFitTargetMiB,
      effectiveFitTargetMiB: calibration.effectiveFitTargetMiB,
      observedFreeMiB: verified.observedFreeMiB,
      predictedTokensPerSecond: verified.probe.predictedPerSecond,
    },
  );
}

/** @param {CalibrationOptions} options @param {Awaited<ReturnType<typeof inspectMtpFitCalibration>>} calibration @param {Awaited<ReturnType<typeof inspectMtpFitCalibration>>} verified */
function emitMtpFitVerified(options, calibration, verified) {
  const message = `MTP fit 보정 확인 완료: 적용 ${calibration.effectiveFitTargetMiB} MiB, 실측 여유 ${verified.observedFreeMiB ?? "확인 불가"} MiB, ${formatTokensPerSecond(verified.probe.predictedPerSecond)}`;
  emitCalibrationProgress(
    options,
    "booting",
    "MTP VRAM 보정 확인 완료",
    message,
    {
      progressMode: "log-only",
      installLogLine: message,
    },
  );
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

/** @param {unknown} value */
function formatTokensPerSecond(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? `${parsed.toFixed(1)} tok/s`
    : "속도 측정 불가";
}

/** @param {unknown[]} values */
function minimumFiniteNumber(values) {
  const finiteValues = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return finiteValues.length ? Math.min(...finiteValues) : null;
}

module.exports = { calibrateMtpFitServer };
