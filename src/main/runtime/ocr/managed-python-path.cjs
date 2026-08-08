// @ts-check

const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { isManagedOcrPackagePathLine } = require("./runtime-preparation.cjs");

/** @param {string} outputDir @param {string} runtimeDir */
function sanitizeStandaloneEmbeddedPythonPathFile(outputDir, runtimeDir) {
  const pthName = findEmbeddedPythonPathFile(outputDir);
  if (!pthName) return;
  const pthPath = path.join(outputDir, pthName);
  try {
    const text = readFileSync(pthPath, "utf8");
    const nextText = buildSanitizedEmbeddedPythonPathText(
      text,
      outputDir,
      runtimeDir,
    );
    if (nextText !== text) writeFileSync(pthPath, nextText, "utf8");
  } catch (_error) {
    // error-policy-allow: the explicit runtime import check reports failures.
  }
}

/** @param {string} outputDir @returns {string} */
function findEmbeddedPythonPathFile(outputDir) {
  try {
    return (
      readdirSync(outputDir).find((name) => /^python\d+._pth$/i.test(name)) ||
      ""
    );
  } catch (_error) {
    return "";
  }
}

/** @param {string} text @param {string} outputDir @param {string} runtimeDir @returns {string} */
function buildSanitizedEmbeddedPythonPathText(text, outputDir, runtimeDir) {
  /** @type {string[]} */
  const sanitized = [];
  for (const line of text.split(/\r?\n/)) {
    appendSanitizedPathLine(sanitized, line, outputDir, runtimeDir);
  }
  while (sanitized.length > 0 && sanitized.at(-1) === "") sanitized.pop();
  if (sanitized.length > 0) sanitized.push("");
  sanitized.push("import site");
  return `${sanitized.join("\n")}\n`;
}

/** @param {string[]} sanitized @param {string} line @param {string} outputDir @param {string} runtimeDir */
function appendSanitizedPathLine(sanitized, line, outputDir, runtimeDir) {
  const trimmed = line.trim();
  if (trimmed === "#import site" || trimmed === "import site") return;
  if (isManagedOcrPackagePathLine(trimmed, outputDir, runtimeDir)) return;
  if (!trimmed && sanitized.at(-1) === "") return;
  sanitized.push(line);
}

module.exports = { sanitizeStandaloneEmbeddedPythonPathFile };
