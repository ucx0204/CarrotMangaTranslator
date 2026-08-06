// @ts-check
/** @typedef {import("../runtime-jsdoc-types").CommandSpec} CommandSpec */
/**
 * @typedef {{ env?: NodeJS.ProcessEnv; failureMessage?: string; onOutput?: ((line: string) => void) | null; signal?: AbortSignal | null; successCodes?: number[]; timeoutMessage?: string; timeoutMs?: number }} RunCommandOptions
 * @typedef {{ write(chunk: unknown): void; flush(): void }} CommandOutputLineEmitter
 * @typedef {{ child: import("node:child_process").ChildProcess; command: CommandSpec; commandText: string; options: RunCommandOptions; stdout: string; stderr: string; stdoutLines: CommandOutputLineEmitter; stderrLines: CommandOutputLineEmitter; timeout: ReturnType<typeof setTimeout> | null; settled: boolean; onAbort: () => void; resolve: (value: {stdout: string; stderr: string}) => void; reject: (error: unknown) => void }} CommandExecution
 */
const { spawn } = require("node:child_process");
const { buildUtilityChildEnv } = require("../simple-page-child-env.cjs");
const { sanitizeInstallLogLine } = require("../simple-page-progress.cjs");
const { terminateChildProcessTree } = require("./process-termination.cjs");
const {
  createAbortError,
  createDetailedError,
  formatCommandForLog,
  normalizeCommandSpec,
  shrinkBuffer,
  truncateText,
} = require("./shell-text.cjs");

/** @param {CommandSpec} command @param {RunCommandOptions} [options] */
function runCommand(command, options = {}) {
  return new Promise((resolve, reject) =>
    startCommand(command, options, resolve, reject),
  );
}

/** @param {CommandSpec} command @param {RunCommandOptions} options @param {CommandExecution["resolve"]} resolve @param {CommandExecution["reject"]} reject */
function startCommand(command, options, resolve, reject) {
  if (options.signal?.aborted) {
    reject(createAbortError());
    return;
  }
  const normalized = normalizeCommandSpec(command);
  const child = spawn(normalized.executable, normalized.args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env || buildUtilityChildEnv({}),
  });
  const execution = createExecution(
    child,
    normalized,
    options,
    resolve,
    reject,
  );
  bindExecution(execution);
  armTimeout(execution);
}

/** @param {import("node:child_process").ChildProcess} child @param {CommandSpec} command @param {RunCommandOptions} options @param {CommandExecution["resolve"]} resolve @param {CommandExecution["reject"]} reject @returns {CommandExecution} */
function createExecution(child, command, options, resolve, reject) {
  const execution = /** @type {CommandExecution} */ ({
    child,
    command,
    commandText: formatCommandForLog(command),
    options,
    stdout: "",
    stderr: "",
    stdoutLines: createCommandOutputLineEmitter(options.onOutput),
    stderrLines: createCommandOutputLineEmitter(options.onOutput),
    timeout: null,
    settled: false,
    onAbort: () => {},
    resolve,
    reject,
  });
  execution.onAbort = () => abortExecution(execution);
  return execution;
}

/** @param {CommandExecution} execution */
function bindExecution(execution) {
  const { child, options } = execution;
  options.signal?.addEventListener?.("abort", execution.onAbort, {
    once: true,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => recordOutput(execution, "stdout", chunk));
  child.stderr?.on("data", (chunk) => recordOutput(execution, "stderr", chunk));
  child.on("error", (error) => rejectExecution(execution, error));
  child.on("close", (code) => handleClose(execution, code));
}

/** @param {CommandExecution} execution @param {"stdout" | "stderr"} stream @param {unknown} chunk */
function recordOutput(execution, stream, chunk) {
  execution[stream] = shrinkBuffer(execution[stream], chunk, 30000);
  execution[`${stream}Lines`].write(chunk);
}

/** @param {CommandExecution} execution */
function armTimeout(execution) {
  const timeoutMs = execution.options.timeoutMs || 0;
  if (timeoutMs <= 0) return;
  execution.timeout = setTimeout(
    () => timeoutExecution(execution, timeoutMs),
    timeoutMs,
  );
}

/** @param {CommandExecution} execution @param {number} timeoutMs */
function timeoutExecution(execution, timeoutMs) {
  terminateChildProcessTree(execution.child);
  rejectExecution(
    execution,
    createDetailedError(
      execution.options.timeoutMessage || "OCR bbox command timed out.",
      buildErrorDetails(execution, { timeoutMs }),
    ),
  );
}

/** @param {CommandExecution} execution */
function abortExecution(execution) {
  terminateChildProcessTree(execution.child);
  rejectExecution(execution, createAbortError());
}

/** @param {CommandExecution} execution @param {unknown} error */
function rejectExecution(execution, error) {
  flushOutput(execution);
  if (execution.settled) return;
  execution.settled = true;
  cleanupExecution(execution);
  execution.reject(error);
}

/** @param {CommandExecution} execution @param {number | null} code */
function handleClose(execution, code) {
  if (execution.settled) return;
  flushOutput(execution);
  const acceptedCodes = validSuccessCodes(execution.options.successCodes);
  if (typeof code === "number" && acceptedCodes.includes(code)) {
    resolveExecution(execution);
    return;
  }
  rejectExecution(execution, buildExitError(execution, code));
}

/** @param {number[] | undefined} successCodes */
function validSuccessCodes(successCodes) {
  return Array.isArray(successCodes) && successCodes.length > 0
    ? successCodes
    : [0];
}

/** @param {CommandExecution} execution @param {number | null} code */
function buildExitError(execution, code) {
  return createDetailedError(
    execution.options.failureMessage ||
      `OCR bbox command failed (${code ?? "null"}).`,
    buildErrorDetails(execution),
  );
}

/** @param {CommandExecution} execution @param {Record<string, unknown>} [extra] */
function buildErrorDetails(execution, extra = {}) {
  return {
    command: execution.commandText,
    executable: execution.command.executable,
    args: [...execution.command.args],
    ...extra,
    stdoutPreview: truncateText(execution.stdout),
    stderrPreview: truncateText(execution.stderr),
  };
}

/** @param {CommandExecution} execution */
function resolveExecution(execution) {
  execution.settled = true;
  cleanupExecution(execution);
  execution.resolve({ stdout: execution.stdout, stderr: execution.stderr });
}

/** @param {CommandExecution} execution */
function flushOutput(execution) {
  execution.stdoutLines.flush();
  execution.stderrLines.flush();
}

/** @param {CommandExecution} execution */
function cleanupExecution(execution) {
  if (execution.timeout) clearTimeout(execution.timeout);
  execution.options.signal?.removeEventListener?.("abort", execution.onAbort);
}

/** @param {RunCommandOptions["onOutput"]} onOutput @returns {CommandOutputLineEmitter} */
function createCommandOutputLineEmitter(onOutput) {
  let pending = "";
  /** @param {string} line */
  const emitLine = (line) => emitSanitizedLine(onOutput, line);
  return {
    write(chunk) {
      if (typeof onOutput !== "function") return;
      pending += String(chunk ?? "").replace(/\u001b\[[0-9;]*m/g, "");
      while (pending.length > 0) {
        const newlineIndex = pending.search(/[\r\n]/);
        if (newlineIndex < 0) {
          if (pending.length > 8192) {
            emitLine(pending.slice(0, 8192));
            pending = pending.slice(8192);
          }
          return;
        }
        emitLine(pending.slice(0, newlineIndex));
        pending = pending.slice(nextLineIndex(pending, newlineIndex));
      }
    },
    flush() {
      if (!pending) return;
      emitLine(pending);
      pending = "";
    },
  };
}

/** @param {string} text @param {number} newlineIndex */
function nextLineIndex(text, newlineIndex) {
  const nextIndex = newlineIndex + 1;
  return text[newlineIndex] === "\r" && text[nextIndex] === "\n"
    ? nextIndex + 1
    : nextIndex;
}

/** @param {RunCommandOptions["onOutput"]} onOutput @param {string} line */
function emitSanitizedLine(onOutput, line) {
  if (typeof onOutput !== "function") return;
  const sanitized = sanitizeInstallLogLine(line);
  if (sanitized) onOutput(sanitized);
}

module.exports = { runCommand };
