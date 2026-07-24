import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureWithCdp } from "./ui-qa/capture.mjs";
import { parseArgs } from "./ui-qa/options.mjs";
import {
  appendLog,
  captureLogs,
  findAvailablePort,
  findBrowserExecutable,
  prepareProfile,
  readPngDimensions,
  status,
  stopProcess,
  waitForHttp,
} from "./ui-qa/process-utils.mjs";

/** @typedef {import("node:child_process").ChildProcess} ChildProcess */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = resolve(root, "src", "renderer");
const options = parseArgs(process.argv.slice(2), root);
const outputPath = resolve(options.output);
const profileRoot = resolve(
  root,
  ".tmp",
  `ui-qa-profile-${process.pid}-${Date.now()}`,
);

/** @type {ChildProcess | null} */
let browserProcess = null;
/** @type {ChildProcess | null} */
let viteProcess = null;
let browserLogs = "";
let viteLogs = "";

async function main() {
  try {
    const targetUrl = await startTarget();
    const browserPath = await prepareBrowser();
    const capture = await capturePage(browserPath, targetUrl);
    await persistAndValidateCapture(capture);
    printResult(browserPath, targetUrl);
  } catch (error) {
    reportFailure(error);
    process.exitCode = 1;
  } finally {
    await cleanUp();
  }
}

/** @returns {Promise<string>} */
async function startTarget() {
  status("starting local target");
  const targetUrl = await resolveTargetUrl();
  status(`target ready: ${targetUrl}`);
  return targetUrl;
}

/** @returns {Promise<string>} */
async function prepareBrowser() {
  const browserPath = await findBrowserExecutable();
  await prepareProfile(profileRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  return browserPath;
}

/** @param {string} browserPath @param {string} targetUrl */
async function capturePage(browserPath, targetUrl) {
  const debuggingPort = await findAvailablePort();
  browserProcess = launchBrowser(browserPath, profileRoot, debuggingPort);
  return captureWithCdp({
    browserProcess,
    buildChannel: options.buildChannel,
    debuggingPort,
    height: options.height,
    targetUrl,
    waitMs: options.waitMs,
    width: options.width,
  });
}

/** @param {Buffer} capture */
async function persistAndValidateCapture(capture) {
  await writeFile(outputPath, capture);
  const dimensions = readPngDimensions(await readFile(outputPath));
  if (
    dimensions.width !== options.width ||
    dimensions.height !== options.height
  ) {
    throw new Error(
      `Captured viewport is ${dimensions.width}x${dimensions.height}; expected ${options.width}x${options.height}.`,
    );
  }
  status("screenshot captured");
}

/** @param {string} browserPath @param {string} targetUrl */
function printResult(browserPath, targetUrl) {
  process.stdout.write(
    `${JSON.stringify(
      {
        browser: browserPath,
        screenshot: outputPath,
        target: targetUrl,
        viewport: {
          requestedWidth: options.width,
          requestedHeight: options.height,
          capturedWidth: options.width,
          capturedHeight: options.height,
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** @param {unknown} error */
function reportFailure(error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  if (viteLogs.trim()) process.stderr.write(`\n[Vite]\n${viteLogs.trim()}\n`);
  if (browserLogs.trim()) {
    process.stderr.write(`\n[Chromium]\n${browserLogs.trim()}\n`);
  }
}

async function cleanUp() {
  await stopProcess(browserProcess);
  await stopProcess(viteProcess);
  if (options.keepProfile) return;
  try {
    await rm(profileRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch (error) {
    process.stderr.write(
      `[ui-qa] could not remove temporary profile ${profileRoot}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/** @returns {Promise<string>} */
async function resolveTargetUrl() {
  if (!options.serve) {
    if (!options.url) throw new Error("A local target URL is required.");
    return options.url;
  }
  const entry = await resolveRendererEntry(options.entry);
  const port = await findAvailablePort();
  viteProcess = launchVite(port);
  captureLogs(viteProcess, (chunk) => {
    viteLogs = appendLog(viteLogs, chunk);
  });
  const url = `http://127.0.0.1:${port}/${entry.urlPath}`;
  await waitForHttp(url, viteProcess, 20_000);
  return url;
}

/** @param {number} port */
function launchVite(port) {
  return spawn(
    process.execPath,
    [
      resolve(root, "node_modules", "vite", "bin", "vite.js"),
      "--config",
      resolve(root, "vite.renderer.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** @param {string} rawEntry */
async function resolveRendererEntry(rawEntry) {
  const suffixIndex = rawEntry.search(/[?#]/);
  const rawPath =
    suffixIndex === -1 ? rawEntry : rawEntry.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : rawEntry.slice(suffixIndex);
  const decodedPath = decodeEntryPath(rawPath, rawEntry);
  const filePath = resolve(rendererRoot, decodedPath);
  const relativePath = relative(rendererRoot, filePath);
  assertRendererEntryPath(relativePath, rawEntry);
  try {
    await access(filePath);
  } catch (error) {
    throw new Error(`Renderer entry does not exist: ${filePath}`, {
      cause: error,
    });
  }
  return {
    urlPath: `${relativePath.split(sep).join("/")}${suffix}`,
  };
}

/** @param {string} rawPath @param {string} rawEntry */
function decodeEntryPath(rawPath, rawEntry) {
  try {
    const decodedPath = decodeURIComponent(rawPath).replace(/^[/\\]+/, "");
    if (!decodedPath) {
      throw new Error("Renderer entry path must not be empty.");
    }
    return decodedPath;
  } catch (error) {
    throw new Error(`Invalid renderer entry path: ${rawEntry}`, {
      cause: error,
    });
  }
}

/** @param {string} relativePath @param {string} rawEntry */
function assertRendererEntryPath(relativePath, rawEntry) {
  const escapesRoot =
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);
  if (escapesRoot) {
    throw new Error(
      `Renderer entry must stay inside ${rendererRoot}: ${rawEntry}`,
    );
  }
}

/** @param {string} browserPath @param {string} profile @param {number} port */
function launchBrowser(browserPath, profile, port) {
  const child = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-mode",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-extensions",
      "--disable-sync",
      "--force-device-scale-factor=1",
      "--no-default-browser-check",
      "--no-first-run",
      "--run-all-compositor-stages-before-draw",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${options.width},${options.height}`,
      "data:text/html,<title>UI QA bootstrap</title><body>UI QA bootstrap</body>",
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TEMP: join(profile, "temp"),
        TMP: join(profile, "temp"),
      },
    },
  );
  captureLogs(child, (chunk) => {
    browserLogs = appendLog(browserLogs, chunk);
  });
  return child;
}

await main();
