// @ts-check
const { createHash } = require("node:crypto");
const { copyFileSync, mkdirSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
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
const GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV =
  "MANGA_TRANSLATOR_GEMMA4_TEMPLATE_CACHE_DIR";

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
 * Current Windows llama.cpp builds cannot open --chat-template-file paths
 * containing non-ASCII characters even though Node can read the same file.
 * Stage only the already verified, pinned bytes in an ASCII temp path.
 *
 * @param {{platform?:string;sourcePath?:string;stagingRoot?:string}} [options]
 * @returns {string}
 */
function prepareGemma4OfficialChatTemplate(options = {}) {
  const platform = options.platform ?? process.platform;
  const sourcePath = verifyGemma4OfficialChatTemplate(
    options.sourcePath ?? resolveGemma4OfficialChatTemplatePath(),
  );
  if (platform !== "win32" || isAsciiPath(sourcePath)) return sourcePath;

  const stagingRoot = resolveAsciiTemplateCacheRoot(options.stagingRoot);
  const templateDir = join(stagingRoot, "chat-templates");
  const stagedPath = join(templateDir, GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE);
  mkdirSync(templateDir, { recursive: true });
  try {
    return verifyGemma4OfficialChatTemplate(stagedPath);
  } catch (_error) {
    // error-policy-allow: a missing or stale cache entry is replaced below.
  }
  copyFileSync(sourcePath, stagedPath);
  return verifyGemma4OfficialChatTemplate(stagedPath);
}

/** @param {string | undefined} configuredRoot */
function resolveAsciiTemplateCacheRoot(configuredRoot) {
  const explicitRoot = String(
    configuredRoot ??
      process.env[GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV] ??
      "",
  ).trim();
  const cacheRoot =
    explicitRoot || join(tmpdir(), "carrot-manga-translator-runtime");
  if (!isAsciiPath(cacheRoot)) {
    throw new Error(
      "llama.cpp on Windows requires an ASCII-only Gemma 4 template cache " +
        `path, but received: ${cacheRoot}. Set ` +
        `${GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV} to an ASCII-only path.`,
    );
  }
  mkdirSync(cacheRoot, { recursive: true });
  return cacheRoot;
}

/** @param {string} value */
function isAsciiPath(value) {
  return /^[\x20-\x7e]+$/.test(value);
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
    prepareGemma4OfficialChatTemplate(),
  ];
}

module.exports = {
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_ENV,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256,
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_SOURCE,
  buildGemma4OfficialChatTemplateArgs,
  prepareGemma4OfficialChatTemplate,
  resolveGemma4OfficialChatTemplatePath,
  shouldUseGemma4OfficialChatTemplate,
  verifyGemma4OfficialChatTemplate,
};
