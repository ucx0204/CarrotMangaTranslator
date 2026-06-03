import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

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
        this.rejectAll(buildFluxRuntimeExitError(code, this.stderrTail.join("")));
      }
    });
  }

  async inpaint(request: FluxWorkerRequest, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.closed || !this.child.stdin.writable) {
      throw new Error(`Flux 인페인팅 런타임이 실행 중이 아닙니다. ${formatFluxRuntimeDetail(this.stderrTail.join(""))}`);
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
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
    } finally {
      if (!this.closed) {
        this.child.kill("SIGTERM");
      }
      this.closed = true;
    }
  }

  isHealthy(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null && this.child.stdin.writable;
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

export function buildRuntimePathEnv(command: string): string {
  const dirs: string[] = [];
  const addDir = (dir: string | null | undefined) => {
    if (!dir || !existsSync(dir)) {
      return;
    }
    const normalized = dir.toLowerCase();
    if (!dirs.some((candidate) => candidate.toLowerCase() === normalized)) {
      dirs.push(dir);
    }
  };

  const runnerDir = dirname(command);
  const toolsDir = dirname(runnerDir);
  addDir(runnerDir);
  addDir(join(toolsDir, "mgt-flux-cuda12.9"));
  addDir(join(toolsDir, "cuda12.9"));
  addDir(process.env.CUDA_PATH_V12_9 ? join(process.env.CUDA_PATH_V12_9, "bin") : null);
  if (isTruthy(process.env.MGT_FLUX_ALLOW_SYSTEM_CUDA)) {
    addDir(process.env.CUDA_PATH ? join(process.env.CUDA_PATH, "bin") : null);
    addDir(process.env.CUDA_HOME ? join(process.env.CUDA_HOME, "bin") : null);
    addDir(process.env.CUDA_PATH_V12_8 ? join(process.env.CUDA_PATH_V12_8, "bin") : null);
    addDir(process.env.CUDA_PATH_V12_4 ? join(process.env.CUDA_PATH_V12_4, "bin") : null);
    for (const pathPart of String(process.env.PATH ?? "").split(delimiter)) {
      addDir(pathPart);
    }
  }

  let current = runnerDir;
  for (let depth = 0; depth < 4; depth += 1) {
    addDir(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs.join(delimiter);
}

export function sanitizeFluxRuntimeStderr(text: string): string {
  return text
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\registry\\src\\[^:\r\n]+/gi, "<rust-crate-source>")
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\git\\checkouts\\[^:\r\n]+/gi, "<rust-git-source>")
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+\\CARGO~1\\registry\\src\\[^:\r\n]+/gi, "<rust-crate-source>")
    .replace(/[A-Z]:\\Users\\[^:\r\n]+?\\tools\\mgt-flux-klein-runner\\[^:\r\n]+/gi, "<flux-runner-source>")
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+\\Downloads\\[^:\r\n]+?\\tools\\mgt-flux-klein-runner\\[^:\r\n]+/gi, "<flux-runner-source>");
}

function buildFluxRuntimeExitError(code: number | null, stderr: string): Error {
  const detail = formatFluxRuntimeDetail(stderr);
  if (/Unable to dynamically load the "cublas"|cublas64_12\.dll|cublas\.dll/i.test(stderr)) {
    return new Error(
      `Flux 인페인팅 런타임이 CUDA cuBLAS DLL(cublas64_12.dll)을 찾지 못했습니다. 앱에 포함된 CUDA 런타임 경로를 확인하세요. ${detail}`
    );
  }
  if (/Unable to dynamically load the "curand"|curand64_10\.dll|curand\.dll/i.test(stderr)) {
    return new Error(
      `Flux 인페인팅 런타임이 CUDA cuRAND DLL(curand64_10.dll)을 찾지 못했습니다. 앱의 Flux CUDA 런타임을 다시 준비해야 합니다. ${detail}`
    );
  }
  if (/Unable to dynamically load the "cudnn"|cudnn64(?:_9|_12)?\.dll|cudnn\.dll/i.test(stderr)) {
    return new Error(
      `Flux 인페인팅 런타임이 cuDNN DLL(cudnn64_9.dll)을 찾지 못했습니다. 최신 설치 파일로 업데이트하거나 앱의 Flux CUDA 런타임을 다시 준비해야 합니다. ${detail}`
    );
  }
  if (isFluxBlackwellRuntimeError(stderr)) {
    return new Error(
      `RTX 50번대/Blackwell에서 Flux CUDA 커널 실행에 실패했습니다. Flux는 앱이 준비한 CUDA 12.9/cuDNN 9.21 런타임만 사용해야 합니다. 앱을 최신 설치 파일로 업데이트하고 Flux 런타임 캐시를 다시 준비하세요. ${detail}`
    );
  }
  return new Error(`Flux 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`);
}

function isFluxBlackwellRuntimeError(stderr: string): boolean {
  return /SM\s*120|sm[_\s-]*120|compute capability\s*12(?:\.0)?|no kernel image is available|invalid device function|unsupported gpu architecture|invalid device kernel image|named symbol not found/i.test(stderr);
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function formatFluxRuntimeDetail(stderr: string): string {
  const detail = sanitizeFluxRuntimeStderr(stderr).replace(/\s+/g, " ").trim().slice(-1600);
  return detail ? `detail=${detail}` : "";
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
