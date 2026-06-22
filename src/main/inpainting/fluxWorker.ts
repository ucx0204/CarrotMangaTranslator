import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { buildFluxWorkerEnv } from "./fluxWorkerEnv";
import {
  buildFluxRuntimeExitError,
  buildFluxWorkerResponseError,
  formatFluxRuntimeDetail,
  sanitizeFluxRuntimeStderr,
} from "./fluxWorkerErrors";
import type {
  FluxWorkerLaunchSpec,
  FluxWorkerRequest,
} from "./fluxWorkerTypes";

export { buildRuntimePathEnv } from "./fluxWorkerEnv";
export {
  buildFluxWorkerResponseError,
  sanitizeFluxRuntimeStderr,
} from "./fluxWorkerErrors";
export type {
  FluxWorkerBackend,
  FluxWorkerLaunchSpec,
  FluxWorkerRequest,
} from "./fluxWorkerTypes";

type FluxWorkerPending = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export class FluxWorker {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail: string[] = [];
  private pending = new Map<string, FluxWorkerPending>();
  private closed = false;

  constructor(private readonly launch: FluxWorkerLaunchSpec) {
    this.child = spawn(launch.executable, launch.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildFluxWorkerEnv(launch),
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
          buildFluxRuntimeExitError(
            code,
            this.stderrTail.join(""),
            this.launch.backend,
          ),
        );
      }
    });
  }

  async inpaint(
    request: FluxWorkerRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || !this.child.stdin.writable) {
      throw new Error(
        `Flux 인페인팅 런타임이 실행 중이 아닙니다. ${formatFluxRuntimeDetail(this.stderrTail.join(""))}`,
      );
    }
    const id = String(this.nextId++);
    const payload = JSON.stringify({
      type: "inpaint",
      id,
      input: request.input,
      mask: request.mask,
      output: request.output,
      steps: request.steps,
      strength: request.strength,
      max_pixels: request.maxPixels,
      mask_padding: request.maskPadding,
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
      this.pending.set(id, { resolve: () => finish(), reject: finish });
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
      if (line.length === 0) {
        continue;
      }
      let response: { id?: string; ok?: boolean; error?: string };
      try {
        response = JSON.parse(line);
      } catch (_error) {
        this.rememberStderr(`Unexpected Flux worker stdout: ${line}\n`);
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
        pending.resolve();
      } else {
        pending.reject(
          buildFluxWorkerResponseError(
            response.error ?? "알 수 없는 오류",
            this.stderrTail.join(""),
            this.launch.backend,
          ),
        );
      }
    }
  }

  private rememberStderr(text: string): void {
    this.stderrTail.push(sanitizeFluxRuntimeStderr(text));
    if (this.stderrTail.length > 80) {
      this.stderrTail.splice(0, this.stderrTail.length - 80);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
