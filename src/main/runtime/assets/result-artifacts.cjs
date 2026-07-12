// @ts-check
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const {
  buildSystemPrompt,
  getOverlayPrompt,
} = require("../simple-page-prompts.cjs");
const { buildArtifactSettings } = require("./result-artifact-settings.cjs");

/**
 * @param {Record<string, any>} options
 * @param {{ requestBody?: Record<string, any>; outputText: string; rawResponse?: unknown }} result
 */
async function saveArtifacts(options, result) {
  await mkdir(options.outputDir, { recursive: true });
  const imageVariants = result.requestBody?.imageVariants || [];
  const payload = {
    label: options.label,
    imagePath: options.imagePath,
    createdAt: new Date().toISOString(),
    settings: buildArtifactSettings(options),
    requestSummary: result.requestBody,
    systemPrompt: buildSystemPrompt(options),
    prompt:
      result.requestBody?.promptText ||
      options.promptOverrideText ||
      getOverlayPrompt(options, imageVariants),
    outputText: result.outputText,
    rawResponse: result.rawResponse,
  };
  await writeJsonArtifact(options.outputDir, payload);
  await writeMarkdownArtifact(options.outputDir, result.outputText);
}

/** @param {string} outputDir @param {Record<string, unknown>} payload */
function writeJsonArtifact(outputDir, payload) {
  return writeFile(
    path.join(outputDir, "result.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/** @param {string} outputDir @param {string} outputText */
function writeMarkdownArtifact(outputDir, outputText) {
  return writeFile(
    path.join(outputDir, "result.md"),
    `${outputText.trim()}\n`,
    "utf8",
  );
}

module.exports = { saveArtifacts };
