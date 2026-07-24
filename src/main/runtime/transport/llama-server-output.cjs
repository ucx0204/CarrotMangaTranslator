// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { label?: string | null }} ServerRuntimeOptions */
/** @typedef {"stdout" | "stderr"} ServerOutputName */
/** @typedef {{ write: (chunk: string, callback?: (error?: Error | null) => void) => unknown; on?: (event: "error", listener: (error: unknown) => void) => unknown; off?: (event: "error", listener: (error: unknown) => void) => unknown; removeListener?: (event: "error", listener: (error: unknown) => void) => unknown }} OutputWriter */
/** @typedef {{ write: (chunk: string, callback?: (error?: Error | null) => void) => unknown; end?: (callback?: (error?: Error | null) => void) => unknown; on?: (event: "error", listener: (error: unknown) => void) => unknown; off?: (event: "error", listener: (error: unknown) => void) => unknown; removeListener?: (event: "error", listener: (error: unknown) => void) => unknown }} ServerLogWriter */
/** @typedef {{ stream: ServerLogWriter | null; header: string[]; creationError?: unknown }} ServerLogTarget */
const { shrinkBuffer } = require("../simple-page-shell-utils.cjs");
const { emitServerInstallLog } = require("./llama-server-logging.cjs");

/**
 * @param {ServerRuntimeOptions} options
 * @param {ServerLogTarget | null} serverLogTarget
 * @param {{ stdout?: OutputWriter; stderr?: OutputWriter }} [parentOutput]
 */
function createServerOutputTransport(
  options,
  serverLogTarget,
  parentOutput = {},
) {
  const recent = { stdout: "", stderr: "" };
  const serverLog = createServerLogBoundary(
    serverLogTarget?.stream ?? null,
    recordServerLogFailure,
  );
  const output = {
    stdout: createParentOutputBoundary(
      "stdout",
      parentOutput.stdout ?? process.stdout,
      recordParentOutputFailure,
    ),
    stderr: createParentOutputBoundary(
      "stderr",
      parentOutput.stderr ?? process.stderr,
      recordParentOutputFailure,
    ),
  };
  let forwardStartupOutput = true;
  if (serverLogTarget?.creationError !== undefined) {
    recordServerLogFailure(normalizeError(serverLogTarget.creationError));
  }
  for (const line of serverLogTarget?.header ?? []) {
    serverLog.write(line);
  }

  return {
    recent,
    dispose() {
      output.stdout.dispose();
      output.stderr.dispose();
      serverLog.dispose();
    },
    stopStartupForwarding() {
      forwardStartupOutput = false;
    },
    /** @param {ServerOutputName} stream @param {unknown} chunk */
    record(stream, chunk) {
      recent[stream] = shrinkBuffer(recent[stream], chunk);
      serverLog.write(`[${stream}] ${chunk}`);
      emitServerInstallLog(options, chunk, forwardStartupOutput);
      if (forwardStartupOutput) {
        output[stream].write(`[llama:${options.label}:${stream}] ${chunk}`);
      }
    },
  };

  /** @param {ServerOutputName} stream @param {Error} error */
  function recordParentOutputFailure(stream, error) {
    const detail = `[parent-${stream}-disabled] ${formatError(error)}\n`;
    recent.stderr = shrinkBuffer(recent.stderr, detail);
    serverLog.write(detail);
  }

  /** @param {Error} error */
  function recordServerLogFailure(error) {
    const detail = `[server-log-disabled] ${formatError(error)}\n`;
    recent.stderr = shrinkBuffer(recent.stderr, detail);
  }
}

/**
 * @param {ServerOutputName} name
 * @param {OutputWriter} stream
 * @param {(name: ServerOutputName, error: Error) => void} onFailure
 */
function createParentOutputBoundary(name, stream, onFailure) {
  let disabled = false;
  let listenerAttached = false;
  /** @param {unknown} error */
  const disable = (error) => {
    if (disabled) return;
    disabled = true;
    onFailure(name, normalizeError(error));
  };
  try {
    if (stream.on && (stream.off || stream.removeListener)) {
      stream.on("error", disable);
      listenerAttached = true;
    }
  } catch (error) {
    disable(error);
  }

  return {
    dispose() {
      if (!listenerAttached) return;
      disabled = true;
      listenerAttached = false;
      try {
        if (stream.off) stream.off("error", disable);
        else stream.removeListener?.("error", disable);
      } catch (error) {
        onFailure(name, normalizeError(error));
      }
    },
    /** @param {string} chunk */
    write(chunk) {
      if (disabled) return;
      try {
        stream.write(chunk, (error) => {
          if (error) disable(error);
        });
      } catch (error) {
        disable(error);
      }
    },
  };
}

/**
 * @param {ServerLogWriter | null} stream
 * @param {(error: Error) => void} onFailure
 */
function createServerLogBoundary(stream, onFailure) {
  let disabled = stream === null;
  let disposed = false;
  let failureReported = false;
  let listenerAttached = false;
  /** @param {unknown} error */
  const disable = (error) => {
    disabled = true;
    if (failureReported) return;
    failureReported = true;
    onFailure(normalizeError(error));
  };
  try {
    if (stream?.on && (stream.off || stream.removeListener)) {
      stream.on("error", disable);
      listenerAttached = true;
    }
  } catch (error) {
    disable(error);
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      disabled = true;
      safelyEndServerLog(stream, disable, detachListener);
    },
    /** @param {string} chunk */
    write(chunk) {
      if (disabled || !stream) return;
      try {
        stream.write(chunk, (error) => {
          if (error) disable(error);
        });
      } catch (error) {
        disable(error);
      }
    },
  };

  function detachListener() {
    if (!listenerAttached || !stream) return;
    listenerAttached = false;
    try {
      if (stream.off) stream.off("error", disable);
      else stream.removeListener?.("error", disable);
    } catch (error) {
      disable(error);
    }
  }
}

/**
 * @param {ServerLogWriter | null} stream
 * @param {(error: unknown) => void} onFailure
 * @param {() => void} detachListener
 */
function safelyEndServerLog(stream, onFailure, detachListener) {
  if (!stream?.end) {
    detachListener();
    return;
  }
  try {
    stream.end((error) => {
      if (error) onFailure(error);
      detachListener();
    });
  } catch (error) {
    onFailure(error);
    detachListener();
  }
}

/** @param {unknown} error */
function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/** @param {Error} error */
function formatError(error) {
  const code =
    "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
  return `${error.name}${code}: ${error.message}`;
}

module.exports = { createServerOutputTransport };
