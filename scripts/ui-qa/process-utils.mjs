import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */

/** @returns {Promise<string>} */
export async function findBrowserExecutable() {
  const candidates = [
    process.env.UI_QA_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((candidate) => typeof candidate === "string");
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      // The next explicit installation path is tried.
      void error;
    }
  }
  throw new Error(
    "No Chromium browser found. Set UI_QA_BROWSER to Edge/Chrome/Chromium.",
  );
}

/** @param {string} profile */
export async function prepareProfile(profile) {
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(join(profile, "local-app-data"), { recursive: true }),
    mkdir(join(profile, "app-data"), { recursive: true }),
    mkdir(join(profile, "temp"), { recursive: true }),
  ]);
}

/**
 * @param {ChildProcess} child
 * @param {(chunk: string) => void} consume
 */
export function captureLogs(child, consume) {
  child.stdout?.on("data", (chunk) => consume(String(chunk)));
  child.stderr?.on("data", (chunk) => consume(String(chunk)));
}

/** @param {string} current @param {string} chunk */
export function appendLog(current, chunk) {
  return `${current}${chunk}`.slice(-12_000);
}

/** @param {ChildProcess | null} child */
export async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(2_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** @returns {Promise<number>} */
export function findAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolvePort(port);
        else reject(new Error("Could not allocate a local port."));
      });
    });
  });
}

/**
 * @param {string} url
 * @param {ChildProcess} child
 * @param {number} timeoutMs
 */
export async function waitForHttp(url, child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      // Vite is still starting.
      void error;
    }
    await delay(120);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** @param {Buffer} buffer */
export function readPngDimensions(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a" || buffer.length < 24) {
    throw new Error("Chromium output is not a valid PNG screenshot.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** @param {string} message */
export function status(message) {
  process.stderr.write(`[ui-qa] ${message}\n`);
}
