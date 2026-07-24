import { spawn } from "node:child_process";
import { sanitizeFluxRuntimeStderr } from "../fluxWorkerErrors";

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onLine?: (line: string) => void;
  } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrTail = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const emitLines = (text: string, isError = false) => {
      const key = isError ? "stderr" : "stdout";
      let buffer = key === "stderr" ? stderrBuffer : stdoutBuffer;
      buffer += text;
      while (true) {
        const newline = findNextLineBreak(buffer);
        if (newline.index < 0) {
          break;
        }
        const line = buffer.slice(0, newline.index).trimEnd();
        buffer = buffer.slice(newline.index + newline.length);
        options.onLine?.(line);
      }
      if (key === "stderr") {
        stderrBuffer = buffer;
      } else {
        stdoutBuffer = buffer;
      }
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new DOMException("Aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) =>
      emitLines(chunk.toString("utf8")),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-2400);
      emitLines(text, true);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("exit", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${code}). ${sanitizeFluxRuntimeStderr(stderrTail).trim()}`,
          ),
        );
      }
    });
  });
}

function findNextLineBreak(text: string): { index: number; length: number } {
  const lf = text.indexOf("\n");
  const cr = text.indexOf("\r");
  if (lf < 0 && cr < 0) {
    return { index: -1, length: 0 };
  }
  if (cr >= 0 && (lf < 0 || cr < lf)) {
    return { index: cr, length: text[cr + 1] === "\n" ? 2 : 1 };
  }
  return { index: lf, length: 1 };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
