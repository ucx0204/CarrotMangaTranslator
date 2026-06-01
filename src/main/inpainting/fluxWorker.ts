import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { delimiter, dirname } from "node:path";

export type FluxWorkerRequest = {
  input: string;
  mask: string;
  output: string;
  steps: number;
  strength: number;
  maxPixels: number;
  maskPadding: number;
};

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

  constructor(runtimePath: string, modelPath: string, vaePath: string, maskPaddingPx: number) {
    this.child = spawn(
      runtimePath,
      ["--transformer-path", modelPath, "--vae-path", vaePath, "--steps", "4", "--strength", "1", "--mask-padding", String(maskPaddingPx)],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildFluxWorkerEnv(runtimePath)
      }
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.rememberStderr(chunk.toString("utf8")));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`Flux 인페인팅 런타임이 종료되었습니다 (${code}). ${this.stderrTail.join("").slice(-1600)}`));
      }
    });
  }

  async inpaint(request: FluxWorkerRequest, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || !this.child.stdin.writable) {
      throw new Error(`Flux 인페인팅 런타임이 실행 중이 아닙니다. ${this.stderrTail.join("").slice(-1600)}`);
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
      mask_padding: request.maskPadding
    });
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.child.kill("SIGTERM");
        this.pending.delete(id);
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
        new Promise((resolve) => setTimeout(resolve, 1500))
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
      } catch {
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
        pending.reject(new Error(`Flux 인페인팅 실패: ${response.error ?? "알 수 없는 오류"}`));
      }
    }
  }

  private rememberStderr(text: string): void {
    this.stderrTail.push(text);
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

function buildRuntimePathEnv(command: string): string {
  const dirs: string[] = [];
  let current = dirname(command);
  for (let depth = 0; depth < 4; depth += 1) {
    if (!dirs.includes(current)) {
      dirs.push(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return [...dirs, process.env.PATH ?? ""].join(delimiter);
}

function buildFluxWorkerEnv(command: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: buildRuntimePathEnv(command),
    PYTHONIOENCODING: "utf-8"
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"] as const) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
