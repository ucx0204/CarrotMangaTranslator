// @ts-check
const { spawn } = require("node:child_process");
const path = require("node:path");
const { buildUtilityChildEnv } = require("../simple-page-child-env.cjs");
const { createImageDetailedError } = require("./image-file-errors.cjs");
const {
  createAbortError,
  shrinkBuffer,
  terminateChildProcessTree,
} = require("../simple-page-shell-utils.cjs");

const IMAGE_PROCESS_TERMINATION_GRACE_MS = 5_000;
const MAX_IMAGE_FFMPEG_STDERR_CHARS = 64 * 1024;

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { maxPixels: number; timeoutMs: number }} ImageProcessOptions */
/** @typedef {{ executable: string; args: string[] }} ImageCommandSpec */
/** @typedef {import("node:child_process").ChildProcessWithoutNullStreams | import("node:child_process").ChildProcess} SpawnedChild */
/** @typedef {{ spawn?: typeof spawn; terminate?: typeof terminateChildProcessTree }} ImageProcessDependencies */
/** @typedef {{ settled: boolean; terminationRequested: boolean; stderr: string; timeout: NodeJS.Timeout | null; forceCloseDeadline: NodeJS.Timeout | null; requestedError: unknown; onAbort: (() => void) | null }} ImageProcessState */
/** @typedef {{ child: SpawnedChild; command: ImageCommandSpec; options: ImageProcessOptions; terminate: typeof terminateChildProcessTree; state: ImageProcessState; resolve: () => void; reject: (error: unknown) => void }} ImageProcessContext */

/**
 * @param {ImageCommandSpec} command
 * @param {ImageProcessOptions} options
 * @param {ImageProcessDependencies} [dependencies]
 * @returns {Promise<void>}
 */
function runImageFfmpegProcess(command, options, dependencies = {}) {
  if (options.abortSignal?.aborted) {
    return Promise.reject(createAbortError());
  }
  const spawnProcess = dependencies.spawn || spawn;
  const terminate = dependencies.terminate || terminateChildProcessTree;
  const child = spawnProcess(command.executable, command.args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: buildUtilityChildEnv(options, [path.dirname(command.executable)]),
  });
  return new Promise((resolve, reject) => {
    const context = createImageProcessContext(
      child,
      command,
      options,
      terminate,
      resolve,
      reject,
    );
    attachImageProcessLifecycle(context);
  });
}

/**
 * @param {SpawnedChild} child
 * @param {ImageCommandSpec} command
 * @param {ImageProcessOptions} options
 * @param {typeof terminateChildProcessTree} terminate
 * @param {() => void} resolve
 * @param {(error: unknown) => void} reject
 * @returns {ImageProcessContext}
 */
function createImageProcessContext(
  child,
  command,
  options,
  terminate,
  resolve,
  reject,
) {
  return {
    child,
    command,
    options,
    terminate,
    resolve,
    reject,
    state: {
      settled: false,
      terminationRequested: false,
      stderr: "",
      timeout: null,
      forceCloseDeadline: null,
      requestedError: null,
      onAbort: null,
    },
  };
}

/** @param {ImageProcessContext} context */
function attachImageProcessLifecycle(context) {
  context.state.onAbort = () =>
    requestImageProcessTermination(context, createAbortError());
  context.options.abortSignal?.addEventListener(
    "abort",
    context.state.onAbort,
    {
      once: true,
    },
  );
  context.state.timeout = setTimeout(
    () => handleImageProcessTimeout(context),
    context.options.timeoutMs,
  );
  if (context.child.stderr) {
    context.child.stderr.on("data", (chunk) =>
      appendImageProcessStderr(context, chunk),
    );
  }
  context.child.on("error", (error) =>
    handleImageProcessStartError(context, error),
  );
  context.child.on("close", (code) => handleImageProcessClose(context, code));
  if (context.options.abortSignal?.aborted) {
    context.state.onAbort();
  }
}

/** @param {ImageProcessContext} context @param {unknown} chunk */
function appendImageProcessStderr(context, chunk) {
  context.state.stderr = shrinkBuffer(
    context.state.stderr,
    chunk,
    MAX_IMAGE_FFMPEG_STDERR_CHARS,
  );
}

/** @param {ImageProcessContext} context */
function handleImageProcessTimeout(context) {
  requestImageProcessTermination(
    context,
    createImageDetailedError("ffmpeg image processing timed out.", {
      timeoutMs: context.options.timeoutMs,
    }),
  );
}

/** @param {ImageProcessContext} context @param {unknown} error */
function handleImageProcessStartError(context, error) {
  requestImageProcessTermination(
    context,
    createImageDetailedError(
      "ffmpeg failed to start for image processing.",
      {
        executable: path.basename(context.command.executable),
        stderr: context.state.stderr.trim(),
      },
      error,
    ),
  );
}

/** @param {ImageProcessContext} context @param {unknown} error */
function requestImageProcessTermination(context, error) {
  if (context.state.settled) return;
  if (context.state.requestedError === null) {
    context.state.requestedError = error;
  }
  if (context.state.terminationRequested) return;
  context.state.terminationRequested = true;
  try {
    context.terminate(context.child);
  } catch (terminationError) {
    if (context.state.requestedError === null) {
      context.state.requestedError = terminationError;
    }
  }
  context.state.forceCloseDeadline = setTimeout(
    () => handleImageProcessForceCloseDeadline(context),
    IMAGE_PROCESS_TERMINATION_GRACE_MS,
  );
}

/** @param {ImageProcessContext} context */
function handleImageProcessForceCloseDeadline(context) {
  const error = createImageDetailedError(
    "ffmpeg image process did not close after termination was requested.",
    {
      stderr: context.state.stderr.trim(),
      terminationGraceMs: IMAGE_PROCESS_TERMINATION_GRACE_MS,
    },
    context.state.requestedError,
  );
  if (isAbortError(context.state.requestedError)) {
    error.name = "AbortError";
  }
  rejectImageProcess(context, error);
}

/** @param {ImageProcessContext} context @param {number | null} code */
function handleImageProcessClose(context, code) {
  if (context.state.settled) return;
  if (context.state.requestedError !== null) {
    rejectImageProcess(context, context.state.requestedError);
    return;
  }
  if (code !== 0) {
    rejectImageProcess(
      context,
      buildImageProcessExitError(code, context.state.stderr),
    );
    return;
  }
  resolveImageProcess(context);
}

/** @param {number | null} code @param {string} stderr */
function buildImageProcessExitError(code, stderr) {
  const normalizedStderr = stderr.trim();
  if (isMissingMaxPixelsOption(normalizedStderr)) {
    return createImageDetailedError(
      "ffmpeg runtime does not support required -max_pixels image safety option.",
      { exitCode: code, stderr: normalizedStderr },
    );
  }
  return createImageDetailedError("ffmpeg image processing failed.", {
    exitCode: code,
    stderr: normalizedStderr,
  });
}

/** @param {string} stderr */
function isMissingMaxPixelsOption(stderr) {
  return (
    /(?:unrecognized|unknown) option[^\n]*max_pixels/i.test(stderr) ||
    /option\s+max_pixels\s+not\s+found/i.test(stderr)
  );
}

/** @param {ImageProcessContext} context @param {unknown} error */
function rejectImageProcess(context, error) {
  if (context.state.settled) return;
  context.state.settled = true;
  cleanupImageProcess(context);
  context.reject(error);
}

/** @param {ImageProcessContext} context */
function resolveImageProcess(context) {
  if (context.state.settled) return;
  context.state.settled = true;
  cleanupImageProcess(context);
  context.resolve();
}

/** @param {ImageProcessContext} context */
function cleanupImageProcess(context) {
  if (context.state.timeout) {
    clearTimeout(context.state.timeout);
    context.state.timeout = null;
  }
  if (context.state.forceCloseDeadline) {
    clearTimeout(context.state.forceCloseDeadline);
    context.state.forceCloseDeadline = null;
  }
  if (context.state.onAbort) {
    context.options.abortSignal?.removeEventListener(
      "abort",
      context.state.onAbort,
    );
  }
}

/** @param {unknown} error */
function isAbortError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError",
  );
}

module.exports = {
  IMAGE_PROCESS_TERMINATION_GRACE_MS,
  runImageFfmpegProcess,
};
