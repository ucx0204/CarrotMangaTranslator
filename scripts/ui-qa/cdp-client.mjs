import { delay, status } from "./process-utils.mjs";

/**
 * @typedef {{
 *   rejectResult: (reason: Error) => void;
 *   resolveResult: (value: Record<string, unknown>) => void;
 *   timeout: NodeJS.Timeout;
 * }} PendingRequest
 * @typedef {(params: Record<string, any>) => void} CdpListener
 */

export class CdpClient {
  /** @param {string} url */
  static async connect(url) {
    if (typeof WebSocket !== "function") {
      throw new Error(
        "This QA tool requires Node.js 24 or newer (WebSocket). ",
      );
    }
    const socket = new WebSocket(url);
    await waitForSocketOpen(socket);
    return new CdpClient(socket);
  }

  /** @param {WebSocket} socket */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, PendingRequest>} */
    this.pending = new Map();
    /** @type {Map<string, Set<CdpListener>>} */
    this.listeners = new Map();
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.handleClose());
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
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

  /** @param {string} method @param {CdpListener} listener */
  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  /** @param {string} method @param {number} timeoutMs */
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

  /** @param {MessageEvent} event */
  handleMessage(event) {
    const message = parseMessage(event);
    if (!message) return;
    if (typeof message.id === "number") {
      this.handleResponse(message);
      return;
    }
    this.emitEvent(message);
  }

  /** @param {Record<string, any>} message */
  handleResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.rejectResult(
        new Error(`CDP error ${message.error.code}: ${message.error.message}`),
      );
      return;
    }
    pending.resolveResult(message.result ?? {});
  }

  /** @param {Record<string, any>} message */
  emitEvent(message) {
    if (typeof message.method !== "string") return;
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

/** @param {WebSocket} socket */
async function waitForSocketOpen(socket) {
  await new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(
      () => rejectOpen(new Error("Timed out opening the DevTools WebSocket.")),
      10_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolveOpen(undefined);
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
}

/** @param {MessageEvent} event @returns {Record<string, any> | null} */
function parseMessage(event) {
  try {
    const parsed = JSON.parse(String(event.data));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    status(
      `ignored unreadable DevTools message (${event.data?.constructor?.name ?? typeof event.data}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * @param {number} port
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeoutMs
 */
export async function waitForPageTarget(port, child, timeoutMs) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Chromium exited early with code ${child.exitCode}.`);
    }
    const target = await fetchPageTarget(endpoint);
    if (target) return target;
    await delay(100);
  }
  throw new Error("Timed out waiting for Chromium's DevTools endpoint.");
}

/** @param {string} endpoint @returns {Promise<Record<string, any> | null>} */
async function fetchPageTarget(endpoint) {
  try {
    const response = await fetch(endpoint);
    if (!response.ok) return null;
    const targets = /** @type {Record<string, any>[]} */ (
      await response.json()
    );
    return (
      targets.find(
        (candidate) =>
          candidate.type === "page" && candidate.webSocketDebuggerUrl,
      ) ?? null
    );
  } catch (error) {
    void error;
    return null;
  }
}

/** @param {CdpClient} cdp */
export async function waitForRenderedResources(cdp) {
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

/** @param {CdpClient} cdp @param {string} expression */
export async function evaluateJson(cdp, expression) {
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

/** @param {Record<string, any>} details */
export function formatExceptionDetails(details) {
  const description = details?.exception?.description;
  if (description) return String(description);
  const text = details?.text || "Unknown renderer exception";
  const location =
    details?.url && Number.isFinite(details?.lineNumber)
      ? ` (${details.url}:${details.lineNumber + 1})`
      : "";
  return `${text}${location}`;
}

/** @param {unknown[]} values */
export function uniqueStrings(values) {
  return [
    ...new Set(values.map((value) => String(value).trim()).filter(Boolean)),
  ];
}
