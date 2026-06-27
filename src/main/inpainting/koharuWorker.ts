import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { basename, delimiter, dirname } from "node:path";
import { buildRuntimePathEnv } from "./fluxWorker";
import {
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "./inpaintingRuntimeLogger";
import type {
  KoharuWorkerLaunchSpec,
  KoharuWorkerRequest,
} from "./koharuWorkerTypes";

export type { KoharuWorkerLaunchSpec, KoharuWorkerRequest };

type KoharuWorkerPending = {
  resolve: () => void;
  reject: (error: Error) => void;
  request: KoharuWorkerRequestSummary;
};

type KoharuWorkerRequestSummary = {
  inputFile: string;
  maskFile: string;
  bubbleMaskFile: string;
  outputFile: string;
  windows: number;
  maxPixels: number | null;
};

type KoharuWorkerResponse = {
  id?: string;
  ok?: boolean;
  error?: string;
  elapsed_ms?: unknown;
};

export class KoharuWorker {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail: string[] = [];
  private pending = new Map<string, KoharuWorkerPending>();
  private closed = false;

  constructor(private readonly launch: KoharuWorkerLaunchSpec) {
    this.child = spawn(launch.executable, launch.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildKoharuWorkerEnv(launch),
    });
    logInpaintingRuntimeInfo("Koharu worker process starting", {
      backend: launch.backend,
      label: launch.label,
      executable: launch.executable,
      runtimePath: launch.runtimePath,
      args: launch.args,
      pid: this.child.pid ?? null,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) =>
      this.rememberStderr(chunk.toString("utf8")),
    );
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.rejectAll(
          new Error(
            `Koharu 인페인팅 런타임이 종료되었습니다 (${code}). ${formatKoharuRuntimeDetail(this.stderrTail.join(""))}`,
          ),
        );
      }
    });
  }

  async inpaint(
    request: KoharuWorkerRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || !this.child.stdin.writable) {
      throw new Error(
        `Koharu 인페인팅 런타임이 실행 중이 아닙니다. ${formatKoharuRuntimeDetail(this.stderrTail.join(""))}`,
      );
    }
    const id = String(this.nextId++);
    const requestSummary = summarizeKoharuWorkerRequest(request);
    const payload = JSON.stringify({
      type: "inpaint",
      id,
      input: request.input,
      mask: request.mask,
      bubble_mask: request.bubbleMask,
      output: request.output,
      windows: request.windows,
      max_pixels: request.maxPixels,
    });
    logInpaintingRuntimeInfo("Koharu inpaint request started", {
      backend: this.launch.backend,
      label: this.launch.label,
      requestId: id,
      ...requestSummary,
    });
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.closed = true;
        this.child.kill("SIGTERM");
        this.rejectAll(new DOMException("Aborted", "AbortError") as Error);
        reject(new DOMException("Aborted", "AbortError") as Error);
      };
      const finish = (error?: Error) => {
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      this.pending.set(id, {
        resolve: () => finish(),
        reject: finish,
        request: requestSummary,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const ok = this.child.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (error) {
          this.pending.delete(id);
          finish(error);
        }
      });
      if (!ok) {
        this.child.stdin.once("drain", () => {});
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      if (this.child.stdin.writable) {
        this.child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
        this.child.stdin.end();
      }
      await Promise.race([
        once(this.child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } finally {
      if (!this.closed) {
        this.child.kill("SIGTERM");
      }
      this.closed = true;
    }
  }

  isHealthy(): boolean {
    return (
      !this.closed &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      this.child.stdin.writable
    );
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let response: KoharuWorkerResponse;
      try {
        response = JSON.parse(line);
      } catch (_error) {
        this.rememberStderr(`Unexpected Koharu worker stdout: ${line}\n`);
        continue;
      }
      const id = response.id;
      if (!id) {
        continue;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        continue;
      }
      this.pending.delete(id);
      if (response.ok) {
        logInpaintingRuntimeInfo("Koharu inpaint request completed", {
          backend: this.launch.backend,
          label: this.launch.label,
          requestId: id,
          elapsedMs: normalizeElapsedMs(response.elapsed_ms),
          ...pending.request,
        });
        pending.resolve();
      } else {
        logInpaintingRuntimeWarn("Koharu inpaint request failed", {
          backend: this.launch.backend,
          label: this.launch.label,
          requestId: id,
          elapsedMs: normalizeElapsedMs(response.elapsed_ms),
          error: response.error ?? "알 수 없는 오류",
          ...pending.request,
        });
        pending.reject(
          new Error(
            `Koharu 인페인팅 실패: ${response.error ?? "알 수 없는 오류"} ${formatKoharuRuntimeDetail(this.stderrTail.join(""))}`,
          ),
        );
      }
    }
  }

  private rememberStderr(text: string): void {
    const sanitized = sanitizeKoharuRuntimeStderr(text);
    this.stderrTail.push(sanitized);
    if (this.stderrTail.length > 80) {
      this.stderrTail.splice(0, this.stderrTail.length - 80);
    }
    logKoharuRuntimeStderr(sanitized, this.launch);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function buildKoharuWorkerEnv(
  launch: KoharuWorkerLaunchSpec,
): NodeJS.ProcessEnv {
  const backend =
    launch.backend === "cpu" || launch.backend === "auto"
      ? "python-cpu"
      : launch.backend;
  return {
    ...launch.env,
    PATH: [
      buildRuntimePathEnv(launch.executable, backend),
      dirname(launch.executable),
      launch.env?.PATH,
      process.env.PATH,
    ]
      .filter(Boolean)
      .join(delimiter),
    RUST_BACKTRACE: launch.env?.RUST_BACKTRACE ?? "1",
    RUST_LOG: launch.env?.RUST_LOG ?? "warn,koharu_runtime=info",
  };
}

function sanitizeKoharuRuntimeStderr(text: string): string {
  return text
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\registry\\src\\[^:\r\n]+/gi,
      "<rust-crate-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\git\\checkouts\\[^:\r\n]+/gi,
      "<rust-git-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^:\r\n]+?\\tools\\mgt-koharu-inpaint-runner\\[^:\r\n]+/gi,
      "<koharu-runner-source>",
    );
}

function formatKoharuRuntimeDetail(stderr: string): string {
  const detail = sanitizeKoharuRuntimeStderr(stderr)
    .replace(/\s+/g, " ")
    .trim()
    .slice(-1600);
  return detail ? `detail=${detail}` : "";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function summarizeKoharuWorkerRequest(
  request: KoharuWorkerRequest,
): KoharuWorkerRequestSummary {
  return {
    inputFile: basename(request.input),
    maskFile: basename(request.mask),
    bubbleMaskFile: basename(request.bubbleMask),
    outputFile: basename(request.output),
    windows: request.windows.length,
    maxPixels: request.maxPixels ?? null,
  };
}

function normalizeElapsedMs(value: unknown): number | undefined {
  const elapsedMs = Number(value);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
}

function logKoharuRuntimeStderr(
  text: string,
  launch: KoharuWorkerLaunchSpec,
): void {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (
      line.startsWith("mgt-koharu-inpaint-runner:") ||
      line.includes("koharu_runtime")
    ) {
      logInpaintingRuntimeInfo("Koharu runtime stderr", {
        backend: launch.backend,
        label: launch.label,
        line,
      });
    }
  }
}
