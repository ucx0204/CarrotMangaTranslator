// @ts-check

const DEFAULT_GRACEFUL_SHUTDOWN_MS = 5_000;
const DEFAULT_FORCED_SHUTDOWN_MS = 2_000;

/**
 * @typedef {{
 *   pid?: number;
 *   exitCode: number | null;
 *   signalCode: NodeJS.Signals | null;
 *   kill: (signal?: NodeJS.Signals | number) => boolean;
 *   once: (event: "exit" | "error", listener: () => void) => unknown;
 *   removeListener: (event: "exit" | "error", listener: () => void) => unknown;
 * }} ManagedChild
 * @typedef {{
 *   children: ManagedChild[];
 *   exit: (code: number) => void;
 *   log?: (message: string) => void;
 *   gracefulShutdownMs?: number;
 *   forcedShutdownMs?: number;
 * }} DevChildLifecycleOptions
 */

/**
 * Keep the development-instance lock alive until Electron and Vite have
 * actually exited, so a following run cannot reuse their profile concurrently.
 *
 * @param {DevChildLifecycleOptions} options
 */
function createDevChildLifecycle(options) {
  const log = options.log ?? (() => {});
  const gracefulShutdownMs =
    options.gracefulShutdownMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS;
  const forcedShutdownMs =
    options.forcedShutdownMs ?? DEFAULT_FORCED_SHUTDOWN_MS;
  /** @type {Promise<void> | null} */
  let shutdownPromise = null;
  let shuttingDown = false;

  /**
   * @param {number} exitCode
   * @param {ManagedChild | null} [excludedChild]
   * @returns {Promise<void>}
   */
  function shutdown(exitCode, excludedChild = null) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = stopChildren(excludedChild).then(() => {
      options.exit(exitCode);
    });
    return shutdownPromise;
  }

  /** @param {ManagedChild | null} excludedChild */
  async function stopChildren(excludedChild) {
    const targets = options.children.filter(
      (child) => child !== excludedChild && isChildRunning(child),
    );
    const gracefulExits = targets.map(waitForChildExit);
    for (const child of targets) {
      signalChild(child, undefined, log);
    }
    if (await settlesWithin(gracefulExits, gracefulShutdownMs)) return;

    const survivors = targets.filter(isChildRunning);
    if (survivors.length === 0) return;
    log(
      `forcing ${survivors.length} development child process(es) to stop after ${gracefulShutdownMs}ms`,
    );
    const forcedExits = survivors.map(waitForChildExit);
    for (const child of survivors) {
      signalChild(child, "SIGKILL", log);
    }
    if (await settlesWithin(forcedExits, forcedShutdownMs)) return;

    const stuckPids = survivors
      .filter(isChildRunning)
      .map((child) => child.pid)
      .filter((pid) => typeof pid === "number");
    if (stuckPids.length > 0) {
      throw new Error(
        `Development child process shutdown timed out (PID ${stuckPids.join(", ")}).`,
      );
    }
  }

  return {
    isShuttingDown: () => shuttingDown,
    shutdown,
  };
}

/** @param {ManagedChild} child */
function isChildRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * @param {ManagedChild} child
 * @param {NodeJS.Signals | undefined} signal
 * @param {(message: string) => void} log
 */
function signalChild(child, signal, log) {
  if (!isChildRunning(child)) return;
  try {
    child.kill(signal);
  } catch (error) {
    log(
      `failed to signal development child${child.pid ? ` PID ${child.pid}` : ""}: ${formatError(error)}`,
    );
  }
}

/** @param {ManagedChild} child @returns {Promise<void>} */
function waitForChildExit(child) {
  if (!isChildRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
    if (!isChildRunning(child)) finish();
  });
}

/**
 * @param {Promise<void>[]} operations
 * @param {number} timeoutMs
 */
function settlesWithin(operations, timeoutMs) {
  if (operations.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void Promise.all(operations).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** @param {unknown} error */
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  createDevChildLifecycle,
  isChildRunning,
};
