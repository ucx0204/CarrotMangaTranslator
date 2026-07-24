import { qaBridgeSource } from "./bridge-source.mjs";
import {
  CdpClient,
  evaluateJson,
  formatExceptionDetails,
  uniqueStrings,
  waitForPageTarget,
  waitForRenderedResources,
} from "./cdp-client.mjs";
import { delay, status } from "./process-utils.mjs";

/**
 * @typedef {{
 *   browserProcess: import("node:child_process").ChildProcess;
 *   buildChannel: "stable" | "mac-alpha";
 *   debuggingPort: number;
 *   height: number;
 *   targetUrl: string;
 *   waitMs: number;
 *   width: number;
 * }} CaptureOptions
 * @typedef {{
 *   body?: { hasContent?: boolean } | null;
 *   root?: { hasContent?: boolean } | null;
 *   runtimeErrors?: unknown[];
 * }} RendererInspection
 */

const rendererInspectionExpression = `(() => {
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
})()`;

/** @param {CaptureOptions} options @returns {Promise<Buffer>} */
export async function captureWithCdp(options) {
  const { browserProcess, debuggingPort } = options;
  status("waiting for Chromium DevTools");
  const target = await waitForPageTarget(debuggingPort, browserProcess, 20_000);
  status("connecting to renderer target");
  const cdp = await CdpClient.connect(String(target.webSocketDebuggerUrl));
  /** @type {string[]} */
  const protocolErrors = [];
  const removeExceptionListener = cdp.on(
    "Runtime.exceptionThrown",
    ({ exceptionDetails }) => {
      protocolErrors.push(formatExceptionDetails(exceptionDetails));
    },
  );
  try {
    await prepareTarget(cdp, options);
    const inspection = await navigateAndInspect(cdp, options);
    assertUsableRenderer(inspection, protocolErrors);
    return await takeScreenshot(cdp);
  } finally {
    removeExceptionListener();
    await closeBrowser(cdp);
  }
}

/** @param {CdpClient} cdp @param {CaptureOptions} options */
async function prepareTarget(cdp, options) {
  status("preparing renderer target");
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Log.enable"),
  ]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: options.height,
    mobile: false,
    screenHeight: options.height,
    screenWidth: options.width,
    width: options.width,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: qaBridgeSource(options.buildChannel),
  });
}

/** @param {CdpClient} cdp @param {CaptureOptions} options */
async function navigateAndInspect(cdp, options) {
  status("navigating renderer");
  const loaded = cdp.waitFor("Page.loadEventFired", 25_000);
  const navigation = await cdp.send("Page.navigate", {
    url: options.targetUrl,
  });
  if (navigation.errorText) {
    throw new Error(`Navigation failed: ${navigation.errorText}`);
  }
  await loaded;
  status("renderer loaded");
  await delay(options.waitMs);
  await waitForRenderedResources(cdp);
  return /** @type {RendererInspection} */ (
    await evaluateJson(cdp, rendererInspectionExpression)
  );
}

/**
 * @param {RendererInspection} inspection
 * @param {string[]} protocolErrors
 */
function assertUsableRenderer(inspection, protocolErrors) {
  if (!inspection?.body?.hasContent) {
    throw new Error("The captured page body is blank.");
  }
  if (inspection.root && !inspection.root.hasContent) {
    throw new Error("The captured #root element is blank.");
  }
  const runtimeErrors = uniqueStrings([
    ...protocolErrors,
    ...(inspection.runtimeErrors ?? []),
  ]);
  if (runtimeErrors.length > 0) {
    throw new Error(
      `Renderer runtime error${runtimeErrors.length === 1 ? "" : "s"}:\n- ${runtimeErrors.join("\n- ")}`,
    );
  }
}

/** @param {CdpClient} cdp */
async function takeScreenshot(cdp) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true,
  });
  if (!screenshot.data) {
    throw new Error("Chromium returned an empty screenshot payload.");
  }
  return Buffer.from(String(screenshot.data), "base64");
}

/** @param {CdpClient} cdp */
async function closeBrowser(cdp) {
  try {
    await cdp.send("Browser.close");
  } catch (error) {
    // Closing the WebSocket remains sufficient if Chromium already exited.
    void error;
  }
  cdp.close();
}
