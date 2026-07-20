// @ts-check
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");

const {
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
} = require("../simple-page-child-env.cjs");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");
const { resolveToolsDir } = require("../model/runtime-locations.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { ffmpegPath?: string | null; toolsDir?: string | null }} RuntimePathOptions */

/** @param {string} toolsDir */
function bundledFfmpegCandidates(toolsDir) {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return [
    path.join(toolsDir || "", "ffmpeg", binaryName),
    path.join(toolsDir || "", "ffmpeg", "bin", binaryName),
    path.join(toolsDir || "", binaryName),
  ];
}

/** @param {RuntimePathOptions} [options] */
function resolveFfmpegPath(options = {}) {
  const toolsDir = resolveToolsDir(options);
  const candidates = bundledFfmpegCandidates(toolsDir);
  const bundledPath = candidates.find(isExistingFilePath);
  if (bundledPath) return bundledPath;
  if (isLikelyPackagedToolsDir(toolsDir)) {
    throw createDetailedError(
      "Bundled ffmpeg is missing from the packaged tools directory.",
      {
        toolsDir,
        candidatePaths: candidates,
        command: "ffmpeg",
      },
    );
  }
  const explicit = [
    options.ffmpegPath,
    runtimeOverrideEnv("MANGA_TRANSLATOR_FFMPEG_PATH", options),
  ].find(isExistingFilePath);
  return (
    explicit ||
    resolveDevelopmentFfmpegPath() ||
    (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
  );
}

/** @returns {string | null} */
function resolveDevelopmentFfmpegPath() {
  try {
    const ffmpegPath = /** @type {unknown} */ (require("ffmpeg-static"));
    return isExistingFilePath(ffmpegPath)
      ? /** @type {string} */ (ffmpegPath)
      : null;
  } catch (_error) {
    // error-policy-allow: packaged apps use the verified bundled tools directory.
    return null;
  }
}

/** @param {unknown} candidate */
function isExistingFilePath(candidate) {
  return (
    typeof candidate === "string" &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  );
}

module.exports = { resolveDevelopmentFfmpegPath, resolveFfmpegPath };
