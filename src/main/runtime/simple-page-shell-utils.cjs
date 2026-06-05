const { spawn } = require("node:child_process");

const { buildUtilityChildEnv } = require("./simple-page-child-env.cjs");
const { sanitizeInstallLogLine } = require("./simple-page-progress.cjs");

function truncateText(value, maxLength = 8000) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function createDetailedError(message, detail = {}, cause) {
  const error = new Error(message);
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}

function shrinkBuffer(current, chunk, maxLength = 12000) {
  const next = `${current}${String(chunk)}`;
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

function renderCommandTemplate(template, replacements) {
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}

function quoteCommandArg(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '\\"')}"`;
}

function runShellCommand(command, { timeoutMs, env, signal, onOutput, timeoutMessage, failureMessage } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: env || buildUtilityChildEnv({})
    });
    let stdout = "";
    let stderr = "";
    let timeout = null;
    let settled = false;
    const stdoutLines = createCommandOutputLineEmitter(onOutput);
    const stderrLines = createCommandOutputLineEmitter(onOutput);

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
    };

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const settleResolve = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => {
      terminateChildProcessTree(child);
      settleReject(createAbortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        terminateChildProcessTree(child);
        settleReject(createDetailedError(timeoutMessage || "OCR bbox command timed out.", {
          command,
          timeoutMs,
          stdoutPreview: truncateText(stdout),
          stderrPreview: truncateText(stderr)
        }));
      }, timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 30000);
      stdoutLines.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 30000);
      stderrLines.write(chunk);
    });
    child.on("error", (error) => {
      stdoutLines.flush();
      stderrLines.flush();
      settleReject(error);
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      stdoutLines.flush();
      stderrLines.flush();
      if (code === 0) {
        settleResolve({ stdout, stderr });
        return;
      }
      settleReject(createDetailedError(failureMessage || `OCR bbox command failed (${code ?? "null"}).`, {
        command,
        stdoutPreview: truncateText(stdout),
        stderrPreview: truncateText(stderr)
      }));
    });
  });
}

function createCommandOutputLineEmitter(onOutput) {
  let pending = "";
  const emitLine = (line) => {
    if (typeof onOutput !== "function") {
      return;
    }
    const sanitized = sanitizeInstallLogLine(line);
    if (sanitized) {
      onOutput(sanitized);
    }
  };

  return {
    write(chunk) {
      if (typeof onOutput !== "function") {
        return;
      }
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

        const line = pending.slice(0, newlineIndex);
        let nextIndex = newlineIndex + 1;
        if (pending[newlineIndex] === "\r" && pending[nextIndex] === "\n") {
          nextIndex += 1;
        }
        pending = pending.slice(nextIndex);
        emitLine(line);
      }
    },
    flush() {
      if (!pending) {
        return;
      }
      emitLine(pending);
      pending = "";
    }
  };
}

function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function terminateChildProcessTree(child) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      env: buildUtilityChildEnv({})
    });
    killer.on("error", () => {
      child.kill("SIGKILL");
    });
    killer.on("close", (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    });
    return;
  }

  child.kill("SIGKILL");
}

module.exports = {
  createAbortError,
  quoteCommandArg,
  renderCommandTemplate,
  runShellCommand,
  shrinkBuffer,
  terminateChildProcessTree
};
