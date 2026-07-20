import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { basename, delimiter, dirname } from "node:path";
import type { BubbleRecoveryHint } from "./bubbleQualityRecovery";
import type { BubbleQualityWorkerLaunch } from "./bubbleQualityRuntime";
import {
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "./inpaintingRuntimeLogger";

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: () => void;
};

type WorkerResponse = {
  elapsed_ms?: unknown;
  error?: string;
  id?: string;
  matched?: unknown;
  ok?: boolean;
};

export class BubbleQualityWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrTail: string[] = [];
  private closed = false;
  private nextId = 1;
  private stdoutBuffer = "";

  constructor(private readonly launch: BubbleQualityWorkerLaunch) {
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
          `말풍선 최고 품질 런타임이 종료되었습니다 (${code}). ${this.runtimeDetail()}`,
        ),
      );
    });
    logInpaintingRuntimeInfo("Bubble quality worker starting", {
      backend: launch.backend,
      model: launch.model,
      pid: this.child.pid ?? null,
    });
  }

  async refine(
    request: { input: string; output: string; hints: BubbleRecoveryHint[] },
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || !this.child.stdin.writable) {
      throw new Error(
        `말풍선 최고 품질 런타임이 실행 중이 아닙니다. ${this.runtimeDetail()}`,
      );
    }
    const id = String(this.nextId++);
    const payload = JSON.stringify({
      type: "refine",
      id,
      input: request.input,
      output: request.output,
      hints: request.hints.map(({ rect }) => rect),
    });
    logInpaintingRuntimeInfo("Conditional bubble recovery request started", {
      backend: this.launch.backend,
      model: this.launch.model,
      hints: request.hints.length,
      inputFile: basename(request.input),
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
        if (error) reject(error);
        else resolve();
      };
      this.pending.set(id, {
        reject: finish,
        resolve: () => finish(),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) return;
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
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      this.child.stdin.end();
      await Promise.race([
        once(this.child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } finally {
      if (!this.closed) this.child.kill("SIGTERM");
      this.closed = true;
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleResponseLine(line);
    }
  }

  private handleResponseLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch (_error) {
      this.rememberStderr(`Unexpected quality worker stdout: ${line}\n`);
      return;
    }
    const pending = response.id ? this.pending.get(response.id) : undefined;
    if (!pending || !response.id) return;
    this.pending.delete(response.id);
    if (response.ok) {
      logInpaintingRuntimeInfo("Conditional bubble recovery completed", {
        backend: this.launch.backend,
        model: this.launch.model,
        matched: Number(response.matched) || 0,
        elapsedMs: Number(response.elapsed_ms) || undefined,
      });
      pending.resolve();
      return;
    }
    const message = response.error ?? "알 수 없는 오류";
    logInpaintingRuntimeWarn("Conditional bubble recovery failed", {
      backend: this.launch.backend,
      model: this.launch.model,
      error: message,
    });
    pending.reject(
      new Error(
        `RT-DETR + SAM 말풍선 복구 실패: ${message} ${this.runtimeDetail()}`,
      ),
    );
  }

  private rememberStderr(text: string): void {
    this.stderrTail.push(text);
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
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function buildWorkerEnv(launch: BubbleQualityWorkerLaunch): NodeJS.ProcessEnv {
  return {
    ...launch.env,
    PATH: [launch.env.PATH, dirname(launch.executable), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
