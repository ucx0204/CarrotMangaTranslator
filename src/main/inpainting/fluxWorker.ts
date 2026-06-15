import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const DEFAULT_ROCM_PATH = process.platform === "win32" ? "" : "/opt/rocm";

export type FluxWorkerRequest = {
  input: string;
  mask: string;
  output: string;
  steps: number;
  strength: number;
  maxPixels: number;
  maskPadding: number;
};

export type FluxWorkerBackend =
  | "cuda-native"
  | "zluda-native"
  | "python-rocm"
  | "python-cpu";

export type FluxWorkerLaunchSpec = {
  backend: FluxWorkerBackend;
  executable: string;
  args: string[];
  runtimePath: string;
  label: string;
  env?: NodeJS.ProcessEnv;
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

export function buildRuntimePathEnv(
  command: string,
  backend: FluxWorkerBackend = "cuda-native",
): string {
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
  if (backend === "cuda-native") {
    addDir(join(toolsDir, "mgt-flux-cuda12.9"));
    addDir(join(toolsDir, "cuda12.9"));
    addDir(
      process.env.CUDA_PATH_V12_9
        ? join(process.env.CUDA_PATH_V12_9, "bin")
        : null,
    );
    if (isTruthy(process.env.MGT_FLUX_ALLOW_SYSTEM_CUDA)) {
      addDir(process.env.CUDA_PATH ? join(process.env.CUDA_PATH, "bin") : null);
      addDir(process.env.CUDA_HOME ? join(process.env.CUDA_HOME, "bin") : null);
      addDir(
        process.env.CUDA_PATH_V12_8
          ? join(process.env.CUDA_PATH_V12_8, "bin")
          : null,
      );
      addDir(
        process.env.CUDA_PATH_V12_4
          ? join(process.env.CUDA_PATH_V12_4, "bin")
          : null,
      );
      for (const pathPart of String(process.env.PATH ?? "").split(delimiter)) {
        addDir(pathPart);
      }
    }
  } else if (backend === "python-rocm" || backend === "python-cpu") {
    const rocmPath = process.env.ROCM_PATH || DEFAULT_ROCM_PATH;
    const hipPath = process.env.HIP_PATH || rocmPath;
    addDir(rocmPath ? join(rocmPath, "bin") : null);
    addDir(rocmPath ? join(rocmPath, "llvm", "bin") : null);
    addDir(hipPath ? join(hipPath, "bin") : null);
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
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\registry\\src\\[^:\r\n]+/gi,
      "<rust-crate-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\git\\checkouts\\[^:\r\n]+/gi,
      "<rust-git-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\CARGO~1\\registry\\src\\[^:\r\n]+/gi,
      "<rust-crate-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^:\r\n]+?\\tools\\mgt-flux-klein-runner\\[^:\r\n]+/gi,
      "<flux-runner-source>",
    )
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\Downloads\\[^:\r\n]+?\\tools\\mgt-flux-klein-runner\\[^:\r\n]+/gi,
      "<flux-runner-source>",
    );
}

function buildFluxRuntimeExitError(
  code: number | null,
  stderr: string,
  backend: FluxWorkerBackend,
): Error {
  const detail = formatFluxRuntimeDetail(stderr);
  if (backend === "zluda-native") {
    if (
      /HIP SDK not found|HIP_PATH|amdhip64|ZLUDA.*unavailable|ZLUDA.*not active/i.test(
        stderr,
      )
    ) {
      return new Error(
        `AMD ZLUDA Flux 런타임을 준비하지 못했습니다. AMD HIP SDK가 설치되어 있고 HIP_PATH가 올바른지 확인하세요. ${detail}`,
      );
    }
    if (
      /Unable to dynamically load the "cublas"|cublas64_12\.dll|cublas\.dll|cublas64\.dll/i.test(
        stderr,
      )
    ) {
      return new Error(
        `AMD ZLUDA Flux 런타임이 cuBLAS 호환 DLL을 찾지 못했습니다. 앱이 ZLUDA DLL alias를 자동으로 준비하므로, 최신 설치 파일로 업데이트한 뒤 Flux 런타임을 다시 준비하세요. ${detail}`,
      );
    }
    if (
      /Unable to dynamically load the "curand"|curand64_10\.dll|curand\.dll|curand64\.dll/i.test(
        stderr,
      )
    ) {
      return new Error(
        `AMD ZLUDA Flux 런타임이 cuRAND DLL(curand64_10.dll)을 찾지 못했습니다. 앱이 Flux CUDA 보조 DLL을 자동으로 준비해야 하므로, 최신 설치 파일로 업데이트한 뒤 Flux 런타임을 다시 준비하세요. ${detail}`,
      );
    }
    if (
      /ZLUDA|nvcuda|cublas64_13|cublasLt64_13|cufft64_12|cudnn64_9|hipError|HSA|amdgpu|gfx/i.test(
        stderr,
      )
    ) {
      return new Error(
        `AMD ZLUDA Flux 런타임이 GPU 실행에 실패했습니다. AMD 드라이버/HIP SDK/ZLUDA 런타임 조합을 확인하세요. ${detail}`,
      );
    }
    return new Error(
      `AMD ZLUDA Flux 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
    );
  }
  if (backend === "python-rocm") {
    if (/ModuleNotFoundError|No module named/i.test(stderr)) {
      return new Error(
        `Flux stable-diffusion.cpp ROCm 런타임 패키지를 불러오지 못했습니다. Flux 런타임 설치를 다시 실행하세요. ${detail}`,
      );
    }
    if (
      /ROCm|HIP|hipError|HSA|gfx|hipblas|rocblas|amdgpu|GPU_TARGETS|AMDGPU_TARGETS/i.test(
        stderr,
      )
    ) {
      return new Error(
        `Flux stable-diffusion.cpp ROCm/HIP 런타임이 AMD GPU를 사용할 수 없습니다. AMD 드라이버, ROCm/HIP 지원 아키텍처, GPU target 설정을 확인하세요. ${detail}`,
      );
    }
    return new Error(
      `Flux stable-diffusion.cpp ROCm 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
    );
  }
  if (backend === "python-cpu") {
    if (/ModuleNotFoundError|No module named/i.test(stderr)) {
      return new Error(
        `Flux Python CPU 런타임 패키지를 불러오지 못했습니다. Flux 런타임 설치를 다시 실행하세요. ${detail}`,
      );
    }
    return new Error(
      `Flux Python CPU 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
    );
  }
  if (
    /Unable to dynamically load the "cublas"|cublas64_12\.dll|cublas\.dll/i.test(
      stderr,
    )
  ) {
    return new Error(
      `Flux 인페인팅 런타임이 CUDA cuBLAS DLL(cublas64_12.dll)을 찾지 못했습니다. 앱에 포함된 CUDA 런타임 경로를 확인하세요. ${detail}`,
    );
  }
  if (
    /Unable to dynamically load the "curand"|curand64_10\.dll|curand\.dll/i.test(
      stderr,
    )
  ) {
    return new Error(
      `Flux 인페인팅 런타임이 CUDA cuRAND DLL(curand64_10.dll)을 찾지 못했습니다. 앱의 Flux CUDA 런타임을 다시 준비해야 합니다. ${detail}`,
    );
  }
  if (
    /Unable to dynamically load the "cudnn"|cudnn64(?:_9|_12)?\.dll|cudnn\.dll/i.test(
      stderr,
    )
  ) {
    return new Error(
      `Flux 인페인팅 런타임이 cuDNN DLL(cudnn64_9.dll)을 찾지 못했습니다. 최신 설치 파일로 업데이트하거나 앱의 Flux CUDA 런타임을 다시 준비해야 합니다. ${detail}`,
    );
  }
  if (isFluxBlackwellRuntimeError(stderr)) {
    return new Error(
      `RTX 50번대/Blackwell에서 Flux CUDA 커널 실행에 실패했습니다. Flux는 앱이 준비한 CUDA 12.9/cuDNN 9.21 런타임만 사용해야 합니다. 앱을 최신 설치 파일로 업데이트하고 Flux 런타임 캐시를 다시 준비하세요. ${detail}`,
    );
  }
  return new Error(
    `Flux 인페인팅 런타임이 종료되었습니다 (${code}). ${detail}`,
  );
}

function buildFluxWorkerResponseError(
  message: string,
  stderr: string,
  backend: FluxWorkerBackend,
): Error {
  const detail = formatFluxRuntimeDetail(stderr);
  const combined = `${message}\n${stderr}`;
  if (backend === "zluda-native") {
    if (
      /Unable to dynamically load the "curand"|curand64_10\.dll|curand\.dll|curand64\.dll/i.test(
        combined,
      )
    ) {
      return new Error(
        `AMD ZLUDA Flux 실행 중 cuRAND DLL(curand64_10.dll)을 찾지 못했습니다. 최신 설치 파일로 Flux 런타임을 갱신한 뒤 다시 시도하세요. 원인=${message}${detail ? ` ${detail}` : ""}`,
      );
    }
    if (
      /CUDA_ERROR_NOT_FOUND|named symbol not found|symbol not found|invalid device function|invalid device kernel image|DriverError/i.test(
        combined,
      )
    ) {
      return new Error(
        `AMD ZLUDA Flux 실행 중 CUDA 호환 함수 호출에 실패했습니다. 앱의 Flux 런너는 CUDA 13/ZLUDA 우회 경로로 빌드되어야 하며, AMD HIP SDK와 드라이버가 맞아야 합니다. 원인=${message}${detail ? ` ${detail}` : ""}`,
      );
    }
    if (/BF16|fma\.rn\.bf16|flash[_ -]?attn|flash attention/i.test(combined)) {
      return new Error(
        `AMD ZLUDA Flux 실행 중 BF16 또는 Flash Attention 경로가 실패했습니다. 최신 설치 파일로 Flux 런너를 갱신한 뒤 다시 시도하세요. 원인=${message}${detail ? ` ${detail}` : ""}`,
      );
    }
  }
  return new Error(
    `Flux 인페인팅 실패: ${message}${detail ? ` ${detail}` : ""}`,
  );
}

function isFluxBlackwellRuntimeError(stderr: string): boolean {
  return /SM\s*120|sm[_\s-]*120|compute capability\s*12(?:\.0)?|no kernel image is available|invalid device function|unsupported gpu architecture|invalid device kernel image|named symbol not found/i.test(
    stderr,
  );
}

function isTruthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function formatFluxRuntimeDetail(stderr: string): string {
  const detail = sanitizeFluxRuntimeStderr(stderr)
    .replace(/\s+/g, " ")
    .trim()
    .slice(-1600);
  return detail ? `detail=${detail}` : "";
}

function buildFluxWorkerEnv(launch: FluxWorkerLaunchSpec): NodeJS.ProcessEnv {
  const launchPath = launch.env?.PATH;
  const rocmPath = process.env.ROCM_PATH || DEFAULT_ROCM_PATH;
  const hipPath = process.env.HIP_PATH || rocmPath;
  const env: NodeJS.ProcessEnv = {
    ...launch.env,
    PATH: [buildRuntimePathEnv(launch.executable, launch.backend), launchPath]
      .filter(Boolean)
      .join(delimiter),
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
  };
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "HOME",
    "ROCM_PATH",
    "HIP_PATH",
    "HIP_VISIBLE_DEVICES",
    "ROCR_VISIBLE_DEVICES",
    "GPU_DEVICE_ORDINAL",
    "HSA_OVERRIDE_GFX_VERSION",
    "HSA_ENABLE_SDMA",
    "PYTORCH_HIP_ALLOC_CONF",
    "LD_LIBRARY_PATH",
    "LIBRARY_PATH",
    "HF_HOME",
    "HUGGINGFACE_HUB_CACHE",
  ] as const) {
    const value = process.env[key];
    if (value && !env[key]) {
      env[key] = value;
    }
  }
  if (
    process.env.PATH &&
    (launch.backend === "python-rocm" || launch.backend === "python-cpu")
  ) {
    env.PATH = `${env.PATH}${delimiter}${process.env.PATH}`;
  }
  if (launch.backend === "python-rocm") {
    if (rocmPath && !env.ROCM_PATH) {
      env.ROCM_PATH = rocmPath;
    }
    if (hipPath && !env.HIP_PATH) {
      env.HIP_PATH = hipPath;
    }
    if (process.platform !== "win32" && rocmPath) {
      env.LD_LIBRARY_PATH = [
        env.LD_LIBRARY_PATH,
        join(rocmPath, "lib"),
        join(rocmPath, "lib64"),
      ]
        .filter(Boolean)
        .join(":");
    }
  }
  if (launch.backend === "zluda-native") {
    if (!env.RUST_BACKTRACE) {
      env.RUST_BACKTRACE = "1";
    }
    if (!env.RUST_LOG) {
      env.RUST_LOG = "warn,koharu_runtime=info";
    }
  }
  return env;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
