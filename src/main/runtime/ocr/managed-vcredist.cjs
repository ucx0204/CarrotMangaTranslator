// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const { existsSync } = require("node:fs");
const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const {
  emitRuntimeProgress,
  runtimeOverrideEnv,
} = require("./host-services.cjs");
const { buildOcrRuntimeEnv } = require("../simple-page-ocr-runtime-config.cjs");
const {
  downloadHfFileWithProgress,
  probeContentLength,
} = require("../simple-page-download-utils.cjs");
const { runCommand } = require("../simple-page-shell-utils.cjs");
const { isTruthy } = require("./config-values.cjs");

const DEFAULT_VCREDIST_X64_URL =
  "https://aka.ms/vs/17/release/vc_redist.x64.exe";

/** @param {RuntimeOptions} options @param {string} runtimeDir @returns {Promise<void>} */
async function ensureMicrosoftVisualCppRuntimeForPaddle(
  options = {},
  runtimeDir,
) {
  if (process.platform !== "win32") {
    return;
  }
  if (!shouldAutoInstallVcredist(options)) {
    emitVcredistDisabled(options);
    return;
  }
  const redistPath = await ensureVcredistInstaller(options, runtimeDir);
  emitVcredistInstalling(options);
  await runVcredistInstaller(options, runtimeDir, redistPath);
}

/** @param {RuntimeOptions} options @returns {boolean} */
function shouldAutoInstallVcredist(options) {
  return isTruthy(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_AUTO_INSTALL_VCREDIST", options) ??
      "true",
  );
}

/** @param {RuntimeOptions} options */
function emitVcredistDisabled(options) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Microsoft Visual C++ 런타임 필요",
    "자동 설치가 비활성화되어 있습니다.",
    {
      progressMode: "log-only",
      installLogLine:
        "Paddle 네이티브 DLL 로딩에 필요한 Microsoft Visual C++ 2015-2022 x64 런타임을 설치해야 합니다.",
    },
  );
}

/** @param {RuntimeOptions} options @param {string} runtimeDir @returns {Promise<string>} */
async function ensureVcredistInstaller(options, runtimeDir) {
  const url = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_VCREDIST_X64_URL", options) ||
      DEFAULT_VCREDIST_X64_URL,
  ).trim();
  const downloadsDir = path.join(runtimeDir, ".downloads", "vcredist");
  const redistPath = path.join(downloadsDir, "vc_redist.x64.exe");
  await mkdir(downloadsDir, { recursive: true });
  if (!existsSync(redistPath)) {
    await downloadVcredistInstaller(options, url, redistPath);
  }
  return redistPath;
}

/** @param {RuntimeOptions} options @param {string} url @param {string} redistPath */
async function downloadVcredistInstaller(options, url, redistPath) {
  const totalBytes = await probeOptionalContentLength(url, options);
  await downloadHfFileWithProgress(
    {
      label: "Microsoft Visual C++ 런타임",
      file: "vc_redist.x64.exe",
      url,
      destination: redistPath,
      progressPhase: "ocr_downloading",
      progressTitle: "Microsoft Visual C++ 런타임 다운로드 중",
      completeTitle: "Microsoft Visual C++ 런타임 다운로드 완료",
    },
    options,
    { totalBytes },
  );
}

/** @param {string} url @param {RuntimeOptions} options @returns {Promise<number>} */
async function probeOptionalContentLength(url, options) {
  try {
    return await probeContentLength(url, options.abortSignal);
  } catch (_error) {
    return 0;
  }
}

/** @param {RuntimeOptions} options */
function emitVcredistInstalling(options) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Microsoft Visual C++ 런타임 설치 중",
    "Paddle 네이티브 DLL 로딩에 필요한 x64 런타임을 준비합니다.",
    {
      progressMode: "indeterminate",
      installLogLine:
        "Microsoft Visual C++ 2015-2022 x64 런타임을 설치/복구합니다. Windows가 권한 확인을 요청하면 허용해 주세요.",
    },
  );
}

/** @param {RuntimeOptions} options @param {string} runtimeDir @param {string} redistPath @returns {Promise<void>} */
async function runVcredistInstaller(options, runtimeDir, redistPath) {
  try {
    await runCommand(
      {
        executable: redistPath,
        args: ["/install", "/quiet", "/norestart"],
      },
      {
        timeoutMs: 600000,
        env: buildOcrRuntimeEnv(options, {
          runtimeDir,
          includePackageDir: false,
        }),
        signal: options.abortSignal,
        successCodes: [0, 3010, 1638],
        failureMessage: "Microsoft Visual C++ runtime installer failed.",
      },
    );
    emitVcredistInstallResult(options, null);
  } catch (error) {
    emitVcredistInstallResult(options, error);
  }
}

/** @param {RuntimeOptions} options @param {unknown} error */
function emitVcredistInstallResult(options, error) {
  const succeeded = !error;
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    succeeded
      ? "Microsoft Visual C++ 런타임 준비 완료"
      : "Microsoft Visual C++ 런타임 설치 실패",
    succeeded
      ? "Paddle OCR import를 다시 확인합니다."
      : error instanceof Error
        ? error.message
        : String(error),
    {
      progressMode: "log-only",
      installLogLine: succeeded
        ? "Microsoft Visual C++ 런타임 준비가 완료되었습니다."
        : "Microsoft Visual C++ 런타임 자동 설치에 실패했습니다. 관리자 권한 또는 Windows 정책 때문에 막혔을 수 있습니다.",
    },
  );
}

module.exports = { ensureMicrosoftVisualCppRuntimeForPaddle };
