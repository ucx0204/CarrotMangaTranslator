// @ts-check
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { isGemma26BModel } = require("./runtime-profile.cjs");

const GEMMA4_OFFICIAL_CHAT_TEMPLATE_ENV =
  "MANGA_TRANSLATOR_GEMMA4_OFFICIAL_CHAT_TEMPLATE";
const GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION =
  "4d7ae4984b7db7de8f8457170b3f1a419ee76d52";
const GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256 =
  "ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4";
const GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES = 18_683;
const GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE = `gemma4-26b-${GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION.slice(0, 8)}.jinja`;
const GEMMA4_OFFICIAL_CHAT_TEMPLATE_SOURCE = `https://huggingface.co/google/gemma-4-26B-A4B-it/raw/${GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION}/chat_template.jinja`;

/** @returns {string} */
function resolveGemma4OfficialChatTemplatePath() {
  return join(__dirname, "..", "templates", GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE);
}

/**
 * The switch only accepts a boolean-like opt-out. It cannot redirect the
 * runtime to an arbitrary template path.
 *
 * @returns {boolean}
 */
function shouldUseGemma4OfficialChatTemplate() {
  const configured = String(
    process.env[GEMMA4_OFFICIAL_CHAT_TEMPLATE_ENV] ?? "",
  )
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(configured);
}

/**
 * @param {string} [templatePath]
 * @returns {string}
 */
function verifyGemma4OfficialChatTemplate(
  templatePath = resolveGemma4OfficialChatTemplatePath(),
) {
  let contents;
  try {
    contents = readFileSync(templatePath);
  } catch (error) {
    throw new Error(
      `Bundled Gemma 4 chat template is unavailable: ${templatePath}. ` +
        `Restore the pinned asset from ${GEMMA4_OFFICIAL_CHAT_TEMPLATE_SOURCE}.`,
      { cause: error },
    );
  }

  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (
    contents.byteLength !== GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES ||
    actualSha256 !== GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256
  ) {
    throw new Error(
      "Bundled Gemma 4 chat template failed its integrity check. " +
        `Expected ${GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES} bytes / ` +
        `${GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256}, received ` +
        `${contents.byteLength} bytes / ${actualSha256}.`,
    );
  }
  return templatePath;
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string[]}
 */
function buildGemma4OfficialChatTemplateArgs(options = {}) {
  if (!isGemma26BModel(options) || !shouldUseGemma4OfficialChatTemplate()) {
    return [];
  }
  return [
    "--jinja",
    "--chat-template-file",
    verifyGemma4OfficialChatTemplate(),
  ];
}

module.exports = {
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_ENV,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_SOURCE,
  buildGemma4OfficialChatTemplateArgs,
  resolveGemma4OfficialChatTemplatePath,
  shouldUseGemma4OfficialChatTemplate,
  verifyGemma4OfficialChatTemplate,
};
