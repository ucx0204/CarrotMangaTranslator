import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = resolve(root, "src", "renderer");
const options = parseArgs(process.argv.slice(2));
const outputPath = resolve(options.output);
const profileRoot = resolve(
  root,
  ".tmp",
  `ui-qa-profile-${process.pid}-${Date.now()}`,
);

let browserProcess = null;
let viteProcess = null;
let browserLogs = "";
let viteLogs = "";

async function main() {
  try {
    status("starting local target");
    const targetUrl = await resolveTargetUrl();
    status(`target ready: ${targetUrl}`);
    const browserPath = await findBrowserExecutable();
    await prepareProfile(profileRoot);
    await mkdir(dirname(outputPath), { recursive: true });
    await rm(outputPath, { force: true });

    const debuggingPort = await findAvailablePort();
    browserProcess = launchBrowser(browserPath, profileRoot, debuggingPort);
    const capture = await captureWithCdp({
      browserProcess,
      debuggingPort,
      height: options.height,
      targetUrl,
      waitMs: options.waitMs,
      width: options.width,
    });
    await writeFile(outputPath, capture);
    const png = await readFile(outputPath);
    const dimensions = readPngDimensions(png);
    if (
      dimensions.width !== options.width ||
      dimensions.height !== options.height
    ) {
      throw new Error(
        `Captured viewport is ${dimensions.width}x${dimensions.height}; expected ${options.width}x${options.height}.`,
      );
    }
    status("screenshot captured");

    process.stdout.write(
      `${JSON.stringify(
        {
          browser: browserPath,
          screenshot: outputPath,
          target: targetUrl,
          viewport: {
            requestedWidth: options.width,
            requestedHeight: options.height,
            capturedWidth: dimensions.width,
            capturedHeight: dimensions.height,
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    if (viteLogs.trim()) process.stderr.write(`\n[Vite]\n${viteLogs.trim()}\n`);
    if (browserLogs.trim()) {
      process.stderr.write(`\n[Chromium]\n${browserLogs.trim()}\n`);
    }
    process.exitCode = 1;
  } finally {
    await stopProcess(browserProcess);
    await stopProcess(viteProcess);
    if (!options.keepProfile) {
      try {
        await rm(profileRoot, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      } catch (error) {
        void error;
      }
    }
  }
}

function parseArgs(args) {
  const parsed = {
    entry: "index.html",
    height: 900,
    keepProfile: false,
    output: join(root, ".tmp", "ui-qa-capture.png"),
    serve: false,
    url: null,
    waitMs: 700,
    width: 1440,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--entry":
        parsed.entry = next();
        parsed.serve = true;
        break;
      case "--height":
        parsed.height = positiveNumber(next(), arg);
        break;
      case "--keep-profile":
        parsed.keepProfile = true;
        break;
      case "--output":
        parsed.output = next();
        break;
      case "--serve":
        parsed.serve = true;
        break;
      case "--url":
        parsed.url = next();
        break;
      case "--wait":
        parsed.waitMs = nonNegativeNumber(next(), arg);
        break;
      case "--width":
        parsed.width = positiveNumber(next(), arg);
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!parsed.serve && !parsed.url) {
    throw new Error("Pass --url <local URL> or --entry <renderer HTML entry>.");
  }
  return parsed;
}

function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return Math.round(number);
}

function nonNegativeNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${flag} must be zero or greater.`);
  }
  return Math.round(number);
}

function printHelp() {
  process.stdout.write(`Local Chromium UI QA\n\n`);
  process.stdout.write(
    `npm run qa:ui -- --entry qa.html --output C:\\tmp\\ui.png [options]\n`,
  );
  process.stdout.write(`npm run qa:ui -- --url http://127.0.0.1:5173/\n\n`);
  process.stdout.write(
    `  --entry <file>     Start Vite and open this renderer entry\n`,
  );
  process.stdout.write(
    `  --serve            Start Vite with the default renderer entry\n`,
  );
  process.stdout.write(
    `  --url <url>        Open an already-running local page\n`,
  );
  process.stdout.write(
    `  --width/--height   Viewport size (1440x900 by default)\n`,
  );
  process.stdout.write(
    `  --wait <ms>        Time to wait after page load before capture\n`,
  );
  process.stdout.write(`  --output <file>    PNG path (defaults to .tmp)\n`);
  process.stdout.write(
    `  --keep-profile     Preserve the Chromium QA profile\n`,
  );
}

async function resolveTargetUrl() {
  if (!options.serve) return options.url;
  const entry = await resolveRendererEntry(options.entry);
  const port = await findAvailablePort();
  const viteBin = resolve(root, "node_modules", "vite", "bin", "vite.js");
  const config = resolve(root, "vite.renderer.config.ts");
  viteProcess = spawn(
    process.execPath,
    [
      viteBin,
      "--config",
      config,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  captureLogs(viteProcess, (chunk) => {
    viteLogs = appendLog(viteLogs, chunk);
  });
  const url = `http://127.0.0.1:${port}/${entry.urlPath}`;
  await waitForHttp(url, viteProcess, 20_000);
  return url;
}

async function resolveRendererEntry(rawEntry) {
  const suffixIndex = rawEntry.search(/[?#]/);
  const rawPath =
    suffixIndex === -1 ? rawEntry : rawEntry.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : rawEntry.slice(suffixIndex);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath).replace(/^[/\\]+/, "");
  } catch (error) {
    throw new Error(`Invalid renderer entry path: ${rawEntry}`, {
      cause: error,
    });
  }
  if (!decodedPath) {
    throw new Error("Renderer entry path must not be empty.");
  }
  const filePath = resolve(rendererRoot, decodedPath);
  const relativePath = relative(rendererRoot, filePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Renderer entry must stay inside ${rendererRoot}: ${rawEntry}`,
    );
  }
  try {
    await access(filePath);
  } catch (error) {
    throw new Error(`Renderer entry does not exist: ${filePath}`, {
      cause: error,
    });
  }
  return {
    filePath,
    urlPath: `${relativePath.split(sep).join("/")}${suffix}`,
  };
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.UI_QA_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      // Try the next local Chromium installation.
      void error;
    }
  }
  throw new Error(
    "No Chromium browser found. Set UI_QA_BROWSER to Edge/Chrome/Chromium.",
  );
}

async function prepareProfile(profile) {
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(join(profile, "local-app-data"), { recursive: true }),
    mkdir(join(profile, "app-data"), { recursive: true }),
    mkdir(join(profile, "temp"), { recursive: true }),
  ]);
}

function launchBrowser(browserPath, profile, debuggingPort) {
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
      `--remote-debugging-port=${debuggingPort}`,
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
        APPDATA: join(profile, "app-data"),
        LOCALAPPDATA: join(profile, "local-app-data"),
        TEMP: join(profile, "temp"),
        TMP: join(profile, "temp"),
        USERPROFILE: profile,
      },
    },
  );
  captureLogs(child, (chunk) => {
    browserLogs = appendLog(browserLogs, chunk);
  });
  return child;
}

async function captureWithCdp({
  browserProcess: child,
  debuggingPort,
  height,
  targetUrl,
  waitMs,
  width,
}) {
  status("waiting for Chromium DevTools");
  const target = await waitForPageTarget(debuggingPort, child, 20_000);
  status("connecting to renderer target");
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  const protocolErrors = [];
  const removeExceptionListener = cdp.on(
    "Runtime.exceptionThrown",
    ({ exceptionDetails }) => {
      protocolErrors.push(formatExceptionDetails(exceptionDetails));
    },
  );

  try {
    status("preparing renderer target");
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Log.enable"),
    ]);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height,
      mobile: false,
      screenHeight: height,
      screenWidth: width,
      width,
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: qaBridgeSource(),
    });

    status("navigating renderer");
    const loaded = cdp.waitFor("Page.loadEventFired", 25_000);
    const navigation = await cdp.send("Page.navigate", { url: targetUrl });
    if (navigation.errorText) {
      throw new Error(`Navigation failed: ${navigation.errorText}`);
    }
    await loaded;
    status("renderer loaded");
    await delay(waitMs);
    await waitForRenderedResources(cdp);

    const inspection = await evaluateJson(
      cdp,
      `(() => {
        const body = document.body;
        const root = document.querySelector("#root");
        const inspect = (element) => {
          if (!element) return null;
          const text = (element.innerText || element.textContent || "").trim();
          const media = element.querySelector(
            "img, svg, canvas, video, iframe, input, button, select, textarea",
          );
          const visibleElement = Array.from(element.querySelectorAll("*")).find(
            (candidate) => {
              const style = getComputedStyle(candidate);
              const rect = candidate.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || 1) > 0 &&
                rect.width > 0 &&
                rect.height > 0
              );
            },
          );
          return {
            childCount: element.childElementCount,
            hasContent: Boolean(text || media || visibleElement),
            textSample: text.slice(0, 160),
          };
        };
        return {
          body: inspect(body),
          root: inspect(root),
          runtimeErrors: Array.isArray(window.__mangaQaRuntimeErrors)
            ? window.__mangaQaRuntimeErrors
            : [],
        };
      })()`,
    );

    if (!inspection?.body?.hasContent) {
      throw new Error("The captured page body is blank.");
    }
    if (inspection.root && !inspection.root.hasContent) {
      throw new Error("The captured #root element is blank.");
    }

    const runtimeErrors = uniqueStrings([
      ...protocolErrors,
      ...(inspection.runtimeErrors ?? []).map(String),
    ]);
    if (runtimeErrors.length > 0) {
      throw new Error(
        `Renderer runtime error${runtimeErrors.length === 1 ? "" : "s"}:\n- ${runtimeErrors.join("\n- ")}`,
      );
    }

    const screenshot = await cdp.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
    });
    if (!screenshot.data) {
      throw new Error("Chromium returned an empty screenshot payload.");
    }
    return Buffer.from(screenshot.data, "base64");
  } finally {
    removeExceptionListener();
    try {
      await cdp.send("Browser.close");
    } catch (error) {
      void error;
    }
    cdp.close();
  }
}

async function waitForPageTarget(port, child, timeoutMs) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Chromium exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (candidate) =>
            candidate.type === "page" && candidate.webSocketDebuggerUrl,
        );
        if (target) return target;
      }
    } catch (error) {
      // Chromium's DevTools endpoint is still starting.
      void error;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Chromium's DevTools endpoint.");
}

async function waitForRenderedResources(cdp) {
  await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `Promise.all([
      document.fonts?.ready ?? Promise.resolve(),
      ...Array.from(document.images).map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
              setTimeout(resolve, 3000);
            }),
      ),
    ])`,
    returnByValue: true,
  });
}

async function evaluateJson(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(formatExceptionDetails(result.exceptionDetails));
  }
  return result.result?.value;
}

function qaBridgeSource() {
  return `(() => {
    const runtimeErrors = [];
    const stringifyReason = (value) => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    Object.defineProperty(window, "__mangaQaRuntimeErrors", {
      configurable: true,
      value: runtimeErrors,
    });
    window.addEventListener("error", (event) => {
      runtimeErrors.push(
        event.error
          ? stringifyReason(event.error)
          : event.message || "Unknown window error",
      );
    });
    window.addEventListener("unhandledrejection", (event) => {
      runtimeErrors.push(
        "Unhandled promise rejection: " + stringifyReason(event.reason),
      );
    });

    const svg = \`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
      <defs>
        <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#f7f1e5"/>
          <stop offset="1" stop-color="#d8d0c2"/>
        </linearGradient>
        <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
          <path d="M80 0H0V80" fill="none" stroke="#9d9487" stroke-width="2" opacity=".35"/>
        </pattern>
      </defs>
      <rect width="1200" height="1600" fill="url(#paper)"/>
      <rect width="1200" height="1600" fill="url(#grid)"/>
      <rect x="72" y="72" width="1056" height="1456" rx="36" fill="none" stroke="#c86548" stroke-width="18"/>
      <path d="M130 1180L410 780l210 230 180-270 270 440z" fill="#403b39" opacity=".82"/>
      <circle cx="830" cy="410" r="170" fill="#c86548" opacity=".85"/>
      <rect x="185" y="210" width="650" height="210" rx="105" fill="#fff" stroke="#252326" stroke-width="12"/>
      <path d="M320 410l-55 125 145-105" fill="#fff" stroke="#252326" stroke-width="12" stroke-linejoin="round"/>
      <text x="510" y="335" text-anchor="middle" font-family="Arial, sans-serif" font-size="68" font-weight="700" fill="#252326">QA PAGE IMAGE</text>
      <text x="600" y="1430" text-anchor="middle" font-family="Arial, sans-serif" font-size="42" fill="#403b39">mangaApi · getPageImageDataUrl</text>
    </svg>\`;
    const pageImageDataUrl =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const defaultFontPreferences = {
      favoriteIds: [],
      orderedIds: [],
      defaultFontId: "default",
    };
    const fontSnapshot = {
      customFonts: [],
      preferences: defaultFontPreferences,
    };
    const implementations = {
      getFontLibrary: async () => fontSnapshot,
      getLibrary: async () => ({ workOrder: [], works: [] }),
      getPageImageDataUrl: async () => pageImageDataUrl,
      getPanelState: async () => null,
      getUiLocale: async () => "ko",
      listCustomFonts: async () => [],
      registerCustomFont: async () => null,
      removeCustomFont: async () => [],
      saveFontPreferences: async (preferences) => ({
        customFonts: [],
        preferences: {
          ...defaultFontPreferences,
          ...(preferences || {}),
        },
      }),
    };
    const mangaApi = new Proxy(implementations, {
      get(target, property) {
        if (property in target) return target[property];
        if (typeof property === "string" && property.startsWith("on")) {
          return () => () => {};
        }
        return async () => null;
      },
    });
    Object.defineProperty(window, "mangaApi", {
      configurable: true,
      value: mangaApi,
      writable: true,
    });
  })();`;
}

function formatExceptionDetails(details) {
  const description = details?.exception?.description;
  if (description) return description;
  const text = details?.text || "Unknown renderer exception";
  const location =
    details?.url && Number.isFinite(details?.lineNumber)
      ? ` (${details.url}:${details.lineNumber + 1})`
      : "";
  return `${text}${location}`;
}

function uniqueStrings(values) {
  return [
    ...new Set(values.map((value) => String(value).trim()).filter(Boolean)),
  ];
}

class CdpClient {
  static async connect(url) {
    if (typeof WebSocket !== "function") {
      throw new Error(
        "This QA tool requires Node.js 24 or newer (WebSocket). ",
      );
    }
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(
        () =>
          rejectOpen(new Error("Timed out opening the DevTools WebSocket.")),
        10_000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolveOpen();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          rejectOpen(new Error("Could not open the DevTools WebSocket."));
        },
        { once: true },
      );
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.handleClose());
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveResult, rejectResult) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectResult(new Error(`Timed out waiting for CDP method ${method}.`));
      }, 15_000);
      this.pending.set(id, { rejectResult, resolveResult, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timeout = setTimeout(() => {
        remove();
        rejectEvent(new Error(`Timed out waiting for CDP event ${method}.`));
      }, timeoutMs);
      const remove = this.on(method, (params) => {
        clearTimeout(timeout);
        remove();
        resolveEvent(params);
      });
    });
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      status(
        `ignored unreadable DevTools message (${event.data?.constructor?.name ?? typeof event.data}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.rejectResult(
          new Error(
            `CDP error ${message.error.code}: ${message.error.message}`,
          ),
        );
      } else {
        pending.resolveResult(message.result ?? {});
      }
      return;
    }
    if (!message.method) return;
    for (const listener of this.listeners.get(message.method) ?? []) {
      listener(message.params ?? {});
    }
  }

  handleClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.rejectResult(
        new Error("DevTools WebSocket closed unexpectedly."),
      );
    }
    this.pending.clear();
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

function readPngDimensions(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a" || buffer.length < 24) {
    throw new Error("Chromium output is not a valid PNG screenshot.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function waitForHttp(url, child, timeoutMs) {
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

function captureLogs(child, consume) {
  child.stdout?.on("data", (chunk) => consume(String(chunk)));
  child.stderr?.on("data", (chunk) => consume(String(chunk)));
}

function appendLog(current, chunk) {
  return `${current}${chunk}`.slice(-12_000);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    delay(2_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function findAvailablePort() {
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

function status(message) {
  process.stderr.write(`[ui-qa] ${message}\n`);
}

await main();
