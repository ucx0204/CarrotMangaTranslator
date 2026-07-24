const { existsSync } = require("node:fs");
const { readFile } = require("node:fs/promises");

/** @template T @param {Promise<T>} promise @param {number} timeoutMs @param {string} message @param {AbortController} [abortController] */
function withTimeout(promise, timeoutMs, message, abortController) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        abortController?.abort();
        reject(new Error(message));
      }, timeoutMs);
    }),
  ]);
}

/** @param {string} filePath */
async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return undefined;
  return JSON.parse(await readFile(filePath, "utf8"));
}

/** @param {string} name @param {number} fallback */
function readIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/** @param {unknown} value @returns {"" | "gemma" | "openai-codex"} */
function normalizeSmokeProvider(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "gemma" || text === "openai-codex") return text;
  if (text === "codex" || text === "openai") return "openai-codex";
  return "";
}

module.exports = {
  normalizeSmokeProvider,
  readIntEnv,
  readJsonIfExists,
  withTimeout,
};
