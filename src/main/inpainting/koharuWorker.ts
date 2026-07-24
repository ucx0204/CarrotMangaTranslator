import { basename, delimiter, dirname } from "node:path";
import { buildRuntimePathEnv } from "./fluxWorkerEnv";
import {
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "./inpaintingRuntimeLogger";
import {
  JsonLinesWorkerClient,
  type JsonLinesWorkerResponse,
} from "./jsonLinesWorkerClient";
import type {
  KoharuWorkerLaunchSpec,
  KoharuWorkerRequest,
} from "./koharuWorkerTypes";

type KoharuWorkerRequestSummary = {
  inputFile: string;
  maskFile: string;
  bubbleMaskFile: string;
  outputFile: string;
  windows: number;
  maxPixels: number | null;
};

type KoharuWorkerOptions = {
  requestTimeoutMs?: number;
};

type KoharuWorkerCommand = {
  type: "inpaint";
  input: string;
  mask: string;
  bubble_mask: string;
  output: string;
  windows: Array<[number, number, number, number]>;
  max_pixels?: number;
};

export class KoharuWorker {
  private readonly client: JsonLinesWorkerClient<KoharuWorkerCommand>;

  constructor(
    private readonly launch: KoharuWorkerLaunchSpec,
    options: KoharuWorkerOptions = {},
  ) {
    this.client = new JsonLinesWorkerClient({
      executable: launch.executable,
      args: launch.args,
      env: buildKoharuWorkerEnv(launch),
      workerName: "Koharu 인페인팅 런타임",
      requestTimeoutMs: options.requestTimeoutMs,
      buildExitError: (code, stderr) =>
        new Error(
          `Koharu 인페인팅 런타임이 종료되었습니다 (${code}). ${formatKoharuRuntimeDetail(stderr)}`,
        ),
      buildNotRunningError: (stderr) =>
        new Error(
          `Koharu 인페인팅 런타임이 실행 중이 아닙니다. ${formatKoharuRuntimeDetail(stderr)}`,
        ),
      sanitizeStderr: sanitizeKoharuRuntimeStderr,
      onStderr: (text) => logKoharuRuntimeStderr(text, launch),
      onSpawn: (pid) => this.logProcessStarting(pid),
    });
  }

  private logProcessStarting(pid: number | null): void {
    logInpaintingRuntimeInfo("Koharu worker process starting", {
      backend: this.launch.backend,
      label: this.launch.label,
      executable: this.launch.executable,
      runtimePath: this.launch.runtimePath,
      args: this.launch.args,
      pid,
    });
  }

  async inpaint(
    request: KoharuWorkerRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const requestSummary = summarizeKoharuWorkerRequest(request);
    const { id, response } = this.client.startRequest(
      {
        type: "inpaint",
        input: request.input,
        mask: request.mask,
        bubble_mask: request.bubbleMask,
        output: request.output,
        windows: request.windows,
        max_pixels: request.maxPixels,
      },
      signal,
    );
    logInpaintingRuntimeInfo("Koharu inpaint request started", {
      backend: this.launch.backend,
      label: this.launch.label,
      requestId: id,
      ...requestSummary,
    });
    const result = await response;
    this.handleResponse(result, requestSummary);
  }

  async dispose(): Promise<void> {
    await this.client.dispose();
  }

  isHealthy(): boolean {
    return this.client.isHealthy();
  }

  private handleResponse(
    response: JsonLinesWorkerResponse,
    request: KoharuWorkerRequestSummary,
  ): void {
    if (response.ok) {
      logInpaintingRuntimeInfo("Koharu inpaint request completed", {
        backend: this.launch.backend,
        label: this.launch.label,
        requestId: response.id,
        elapsedMs: normalizeElapsedMs(response.elapsed_ms),
        ...request,
      });
      return;
    }
    logInpaintingRuntimeWarn("Koharu inpaint request failed", {
      backend: this.launch.backend,
      label: this.launch.label,
      requestId: response.id,
      elapsedMs: normalizeElapsedMs(response.elapsed_ms),
      error: response.error ?? "알 수 없는 오류",
      ...request,
    });
    throw new Error(
      `Koharu 인페인팅 실패: ${response.error ?? "알 수 없는 오류"} ${formatKoharuRuntimeDetail(this.client.getStderr())}`,
    );
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
    )
    .replace(
      /\/Users\/[^/\r\n]+\/(?:\.cargo\/(?:registry\/src|git\/checkouts)|[^:\r\n]*?\/tools\/mgt-koharu-inpaint-runner)\/[^:\r\n]+/g,
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
