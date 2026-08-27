const { spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createInterface } = require("node:readline");
const {
  CODEX_APP_SERVER_ARGUMENTS,
} = require("./codex-app-server-runtime.cjs");

/**
 * @typedef {{
 *   id?: number;
 *   error?: unknown;
 *   result?: { requiresOpenaiAuth?: unknown };
 * }} AppServerMessage
 */

const executablePath = process.argv[2] ? resolve(process.argv[2]) : "";
if (!executablePath) {
  throw new Error("Packaged Codex executable path is required.");
}

void runSmoke();

async function runSmoke() {
  const smokeRoot = mkdtempSync(join(tmpdir(), "mgt-codex-app-server-smoke-"));
  const codexHome = join(smokeRoot, "codex-home");
  mkdirSync(codexHome);
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    RUST_LOG: "warn",
  };
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
  ]) {
    delete env[key];
  }
  const child = spawn(executablePath, CODEX_APP_SERVER_ARGUMENTS, {
    cwd: tmpdir(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  /** @type {string[]} */
  const stderr = [];
  /** @type {Error | null} */
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  /** @type {import("node:readline").Interface | undefined} */
  let lines;
  try {
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    /** @type {AppServerMessage[]} */
    const messages = [];
    lines.on("line", (line) => {
      try {
        messages.push(JSON.parse(line));
      } catch (_error) {
        // error-policy-allow: the timeout/error path reports bounded stderr and the invalid stream.
        // The timeout/error path reports bounded stderr and the invalid stream.
      }
    });
    send(child, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "carrot_manga_translator_package_smoke",
          title: "Carrot Manga Translator package smoke",
          version: "1",
        },
        capabilities: { experimentalApi: false },
      },
    });
    await waitFor(
      messages,
      (message) => message.id === 1,
      child,
      stderr,
      () => spawnError,
    );
    send(child, { method: "initialized" });
    send(child, {
      id: 2,
      method: "account/read",
      params: { refreshToken: false },
    });
    const account = await waitFor(
      messages,
      (message) => message.id === 2,
      child,
      stderr,
      () => spawnError,
    );
    if (
      account.error ||
      typeof account.result?.requiresOpenaiAuth !== "boolean"
    ) {
      throw new Error(
        `Codex account/read smoke returned an invalid result: ${JSON.stringify(account)}`,
      );
    }
    console.log("packaged-codex-app-server-ok");
  } finally {
    lines?.close();
    if (!child.stdin.destroyed) child.stdin.end();
    await stopChild(child);
    rmSync(smokeRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

/**
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
 * @returns {Promise<void>}
 */
function stopChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStopped) => {
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill();
    }, 1_500);
    const timeout = setTimeout(resolveStopped, 4_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      clearTimeout(timeout);
      resolveStopped();
    });
  });
}

/**
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
 * @param {Record<string, unknown>} message
 */
function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
}

/**
 * @param {AppServerMessage[]} messages
 * @param {(message: AppServerMessage) => boolean} predicate
 * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
 * @param {string[]} stderr
 * @param {() => Error | null} readSpawnError
 * @returns {Promise<AppServerMessage>}
 */
function waitFor(messages, predicate, child, stderr, readSpawnError) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const match = messages.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
        return;
      }
      const spawnError = readSpawnError();
      if (
        spawnError ||
        child.exitCode !== null ||
        Date.now() - startedAt >= 15_000
      ) {
        clearInterval(timer);
        reject(
          new Error(
            `Codex App Server smoke timed out or exited. ${spawnError ? String(spawnError) : ""} ${stderr.join("").slice(-4000)}`,
          ),
        );
      }
    }, 20);
  });
}
