import { basename } from "node:path";
import { buildFluxWorkerEnv } from "./fluxWorkerEnv";
import {
  buildFluxRuntimeExitError,
  buildFluxWorkerResponseError,
  formatFluxRuntimeDetail,
  sanitizeFluxRuntimeStderr,
} from "./fluxWorkerErrors";
import {
  JsonLinesWorkerClient,
  type JsonLinesWorkerResponse,
} from "../runtimeSupport/jsonLinesWorkerClient";
import type {
  FluxWorkerLaunchSpec,
  FluxWorkerRequest,
} from "./fluxWorkerTypes";
import {
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "./inpaintingRuntimeLogger";

type FluxWorkerRequestSummary = {
  inputFile: string;
  maskFile: string;
  outputFile: string;
  steps: number;
  strength: number;
  maxPixels: number;
  maskPadding: number;
};

export type FluxWorkerDiagnostics = {
  info: (message: string, detail?: unknown) => void;
  warn: (message: string, detail?: unknown) => void;
};

const productionDiagnostics: FluxWorkerDiagnostics = {
  info: logInpaintingRuntimeInfo,
  warn: logInpaintingRuntimeWarn,
};

type FluxWorkerOptions = {
  diagnostics?: FluxWorkerDiagnostics;
  requestTimeoutMs?: number;
};

type FluxWorkerCommand = {
  type: "inpaint";
  input: string;
  mask: string;
  output: string;
  steps: number;
  strength: number;
  max_pixels: number;
  mask_padding: number;
};

export class FluxWorker {
  private readonly client: JsonLinesWorkerClient<FluxWorkerCommand>;
  private readonly diagnostics: FluxWorkerDiagnostics;

  constructor(
    private readonly launch: FluxWorkerLaunchSpec,
    options: FluxWorkerOptions = {},
  ) {
    this.diagnostics = options.diagnostics ?? productionDiagnostics;
    this.client = new JsonLinesWorkerClient({
      executable: launch.executable,
      args: launch.args,
      env: buildFluxWorkerEnv(launch),
      workerName: "Flux 인페인팅 런타임",
      requestTimeoutMs: options.requestTimeoutMs,
      buildExitError: (code, stderr) =>
        buildFluxRuntimeExitError(code, stderr, launch.backend),
      buildNotRunningError: (stderr) =>
        new Error(
          `Flux 인페인팅 런타임이 실행 중이 아닙니다. ${formatFluxRuntimeDetail(stderr)}`,
        ),
      sanitizeStderr: sanitizeFluxRuntimeStderr,
      onStderr: (text) => logFluxRuntimeStderr(text, launch, this.diagnostics),
      onSpawn: (pid) => this.logProcessStarting(pid),
      onTerminationError: (error) =>
        this.diagnostics.warn("Flux worker process-tree termination failed", {
          backend: this.launch.backend,
          label: this.launch.label,
          error,
        }),
    });
  }

  private logProcessStarting(pid: number | null): void {
    this.diagnostics.info("Flux worker process starting", {
      backend: this.launch.backend,
      label: this.launch.label,
      executable: this.launch.executable,
      runtimePath: this.launch.runtimePath,
      args: this.launch.args,
      pid,
    });
  }

  async inpaint(
    request: FluxWorkerRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const requestSummary = summarizeFluxWorkerRequest(request);
    const { id, response } = this.client.startRequest(
      {
        type: "inpaint",
        input: request.input,
        mask: request.mask,
        output: request.output,
        steps: request.steps,
        strength: request.strength,
        max_pixels: request.maxPixels,
        mask_padding: request.maskPadding,
      },
      signal,
    );
    this.diagnostics.info("Flux inpaint crop started", {
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
    request: FluxWorkerRequestSummary,
  ): void {
    if (response.ok) {
      this.diagnostics.info("Flux inpaint crop completed", {
        backend: this.launch.backend,
        label: this.launch.label,
        requestId: response.id,
        elapsedMs: normalizeElapsedMs(response.elapsed_ms),
        ...request,
      });
      return;
    }
    this.diagnostics.warn("Flux inpaint crop failed", {
      backend: this.launch.backend,
      label: this.launch.label,
      requestId: response.id,
      elapsedMs: normalizeElapsedMs(response.elapsed_ms),
      error: response.error ?? "알 수 없는 오류",
      ...request,
    });
    throw buildFluxWorkerResponseError(
      response.error ?? "알 수 없는 오류",
      this.client.getStderr(),
      this.launch.backend,
    );
  }
}

function summarizeFluxWorkerRequest(
  request: FluxWorkerRequest,
): FluxWorkerRequestSummary {
  return {
    inputFile: basename(request.input),
    maskFile: basename(request.mask),
    outputFile: basename(request.output),
    steps: request.steps,
    strength: request.strength,
    maxPixels: request.maxPixels,
    maskPadding: request.maskPadding,
  };
}

function normalizeElapsedMs(value: unknown): number | undefined {
  const elapsedMs = Number(value);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
}

function logFluxRuntimeStderr(
  text: string,
  launch: FluxWorkerLaunchSpec,
  diagnostics: FluxWorkerDiagnostics,
): void {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("mgt-flux-klein:")) {
      diagnostics.info("Flux runtime stderr", {
        backend: launch.backend,
        label: launch.label,
        line,
      });
    }
  }
}
