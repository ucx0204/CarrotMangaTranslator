// @ts-check
const { existsSync } = require("node:fs");
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
  const bundledPath = candidates.find((candidate) => existsSync(candidate));
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
  ].find((candidate) => typeof candidate === "string" && existsSync(candidate));
  return explicit || (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

module.exports = { resolveFfmpegPath };
