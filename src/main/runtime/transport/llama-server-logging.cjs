// @ts-check
const { createWriteStream, mkdirSync } = require("node:fs");
const path = require("node:path");
const { sanitizeInstallLogLine } = require("../simple-page-progress.cjs");
const {
  resolveConfiguredModelFile,
} = require("../simple-page-model-config.cjs");
const { emitRuntimeProgress } = require("../simple-page-runtime-common.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { label?: string | null; serverLogPath?: string | null }} ServerRuntimeOptions */

/** @param {ServerRuntimeOptions} options @param {string} serverPath @param {string[]} launchArgs */
function createServerLogStream(options, serverPath, launchArgs) {
  const logPath = String(options.serverLogPath ?? "").trim();
  if (!logPath) return null;
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const stream = createWriteStream(logPath, { flags: "a" });
    stream.write(`# ${new Date().toISOString()}\n`);
    stream.write(`# serverPath=${serverPath}\n`);
    stream.write(`# launchArgs=${launchArgs.join(" ")}\n`);
    return stream;
  } catch (_error) {
    return null;
  }
}

/** @param {ServerRuntimeOptions} options @param {unknown} chunk */
function emitServerInstallLog(options = {}, chunk) {
  for (const part of String(chunk ?? "").split(/[\r\n]+/)) {
    const line = sanitizeInstallLogLine(part);
    if (line) emitServerLogLine(options, line);
  }
}

/** @param {ServerRuntimeOptions} options @param {string} line */
function emitServerLogLine(options, line) {
  emitRuntimeProgress(
    options,
    "booting",
    "Gemma 서버 로그",
    `${resolveConfiguredModelFile(options)} 실행 중`,
    {
      progressMode: "log-only",
      installLogLine: line,
    },
  );
}

module.exports = { createServerLogStream, emitServerInstallLog };
