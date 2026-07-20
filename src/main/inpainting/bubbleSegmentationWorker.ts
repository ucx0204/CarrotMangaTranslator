import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { basename, delimiter, dirname } from "node:path";
import { buildRuntimePathEnv } from "./fluxWorker";
import {
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "./inpaintingRuntimeLogger";
import type { KoharuWorkerLaunchSpec } from "./koharuWorkerTypes";

export type BubbleSegmentationWorkerRequest = {
  confidenceThreshold?: number;
  input: string;
  nmsThreshold?: number;
  output: string;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: () => void;
  summary: { inputFile: string; outputFile: string };
};

type WorkerResponse = {
  elapsed_ms?: unknown;
  error?: string;
  id?: string;
  ok?: boolean;
};

export class BubbleSegmentationWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrTail: string[] = [];
  private closed = false;
  private nextId = 1;
  private stdoutBuffer = "";

  constructor(private readonly launch: KoharuWorkerLaunchSpec) {
    this.child = spawn(launch.executable, launch.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildWorkerEnv(launch),
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) =>
      this.rememberStderr(chunk.toString("utf8")),
    );
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      this.closed = true;
      this.rejectAll(
        new Error(
          `말풍선 정밀 감지 런타임이 종료되었습니다 (${code}). ${this.runtimeDetail()}`,
        ),
      );
    });
    logInpaintingRuntimeInfo("Bubble segmentation worker starting", {
      backend: launch.backend,
      executable: launch.executable,
      pid: this.child.pid ?? null,
    });
  }

  async segment(
    request: BubbleSegmentationWorkerRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || !this.child.stdin.writable) {
      throw new Error(
        `말풍선 정밀 감지 런타임이 실행 중이 아닙니다. ${this.runtimeDetail()}`,
      );
    }
    const id = String(this.nextId++);
    const summary = {
      inputFile: basename(request.input),
      outputFile: basename(request.output),
    };
    const payload = JSON.stringify({
      type: "segment",
      id,
      input: request.input,
      output: request.output,
      confidence_threshold: request.confidenceThreshold,
      nms_threshold: request.nmsThreshold,
    });
    logInpaintingRuntimeInfo("Bubble segmentation request started", {
      backend: this.launch.backend,
      requestId: id,
      ...summary,
    });

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.closed = true;
        this.child.kill("SIGTERM");
        const error = new DOMException("Aborted", "AbortError") as Error;
        this.rejectAll(error);
        reject(error);
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
        reject: finish,
        resolve: () => finish(),
        summary,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }
        this.pending.delete(id);
        finish(error);
      });
    });
  }

  isHealthy(): boolean {
    return (
      !this.closed &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      this.child.stdin.writable
    );
  }

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      this.child.stdin.end();
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

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleResponseLine(line);
      }
    }
  }

  private handleResponseLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch (_error) {
      this.rememberStderr(`Unexpected segmentation stdout: ${line}\n`);
      return;
    }
    const pending = response.id ? this.pending.get(response.id) : undefined;
    if (!pending || !response.id) {
      return;
    }
    this.pending.delete(response.id);
    if (response.ok) {
      logInpaintingRuntimeInfo("Bubble segmentation request completed", {
        backend: this.launch.backend,
        elapsedMs: normalizeElapsedMs(response.elapsed_ms),
        requestId: response.id,
        ...pending.summary,
      });
      pending.resolve();
      return;
    }
    const message = response.error ?? "알 수 없는 오류";
    logInpaintingRuntimeWarn("Bubble segmentation request failed", {
      backend: this.launch.backend,
      error: message,
      requestId: response.id,
      ...pending.summary,
    });
    pending.reject(
      new Error(`말풍선 정밀 감지 실패: ${message} ${this.runtimeDetail()}`),
    );
  }

  private rememberStderr(text: string): void {
    const sanitized = sanitizeRuntimeStderr(text);
    this.stderrTail.push(sanitized);
    if (this.stderrTail.length > 80) {
      this.stderrTail.splice(0, this.stderrTail.length - 80);
    }
  }

  private runtimeDetail(): string {
    const detail = this.stderrTail
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(-1600);
    return detail ? `detail=${detail}` : "";
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function buildWorkerEnv(launch: KoharuWorkerLaunchSpec): NodeJS.ProcessEnv {
  const backend =
    launch.backend === "cpu" || launch.backend === "auto"
      ? "python-cpu"
      : launch.backend;
  return {
    ...launch.env,
    PATH: [
      launch.env?.PATH,
      buildRuntimePathEnv(launch.executable, backend),
      dirname(launch.executable),
      process.env.PATH,
    ]
      .filter(Boolean)
      .join(delimiter),
    RUST_BACKTRACE: launch.env?.RUST_BACKTRACE ?? "1",
    RUST_LOG: launch.env?.RUST_LOG ?? "warn,koharu_runtime=info",
  };
}

function sanitizeRuntimeStderr(text: string): string {
  return text
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\(?:registry\\src|git\\checkouts)\\[^:\r\n]+/gi,
      "<rust-source>",
    )
    .replace(
      /\/Users\/[^/\r\n]+\/(?:\.cargo\/(?:registry\/src|git\/checkouts)|[^:\r\n]*?\/tools\/mgt-koharu-inpaint-runner)\/[^:\r\n]+/g,
      "<rust-source>",
    );
}

function normalizeElapsedMs(value: unknown): number | undefined {
  const elapsedMs = Number(value);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
