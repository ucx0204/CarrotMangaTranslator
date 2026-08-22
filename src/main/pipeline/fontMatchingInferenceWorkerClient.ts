/**
 * Font matching inference worker client — FontMatchingPageInferencePort 구현.
 *
 * 메인 이벤트 루프를 차단하는 동기 heavy 추론을 fontMatchingInferenceWorker
 * (worker_threads)로 오프로드한다. 메인은 IPC/취소/진행을 계속 서비스하고,
 * 이 포트는:
 *   1. 게이트(boundary/targetLanguage/runtime status/catalog snapshot) 검사 —
 *      sealed 모듈의 동일 불변량 재사용(assertUserPageBoundary/sameCandidateSnapshot/
 *      emptyResult/disabled).
 *   2. 래스터 디코드(nativeImage, Electron 메인 전용)를 메인에서 수행해 BGRA 버퍼를
 *      transferable로 워커에 전달(복사 없음).
 *   3. 워커에서 온 추론 결과를 FontMatchingPageInferenceResult로 포장.
 *
 * 워커 스폰/init/크래시 실패 시 createDefaultFontMatchingPageInferencePort(기존
 * in-process 포트)로 폴백 — 테스트/이상 환경 견고성 + in-process 경로 유지.
 */
import { Worker } from "node:worker_threads";
import type { AppPaths } from "../appPaths";
import type { UiLocale } from "../../shared/uiLocales";
import type {
  FontMatchingPageInferencePort,
  FontMatchingPageInferenceRequest,
  FontMatchingPageInferenceResult,
  VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRuntimeArtifactStatus } from "./fontMatchingRuntimeArtifactStatus";
import type { AutoMatchActiveCandidateSelection } from "./autoMatchActiveCatalogTypes";
import type {
  FontMatchingWorkerOutboundMessage,
  SerializedError,
} from "./fontMatchingInferenceWorker";
import {
  createDefaultFontMatchingPageInferencePort,
  resolveFontMatchingOrtWasmAssets,
  assertUserPageBoundary,
  sameCandidateSnapshot,
  emptyResult,
  disabled,
  type OrtWasmAssets,
} from "./fontMatchingPagePixelInference";
import { loadFontMatchingPageRaster } from "../fontMatchingPageImage";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";
import type { MangaPage } from "../../shared/libraryTypes";
import { resolveFontMatchingArtifactDirSync } from "./fontMatchingRuntimePaths";
import { isKoreanLanguageCode } from "../../shared/translationLanguages";
import { resolveCrossScriptProxyRuntimeDir } from "./fontMatchingCrossScriptProxyPaths";

type WorkerClientDependencies = Readonly<{
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">;
  loadSelection: (
    locale: UiLocale,
  ) => Pick<
    AutoMatchActiveCandidateSelection,
    "candidates" | "installedCandidates"
  >;
  reportWarning?: (message: string, detail: unknown) => void;
  /** 워커 스크립트 경로 해석. 기본값은 컴파일된 sibling .js 를 require.resolve. */
  resolveWorkerScript?: () => string;
  /** 페이지 래스터 디코드(nativeImage). 기본값은 실구현. 테스트 주입용. */
  loadRaster?: (
    page: MangaPage,
    signal?: AbortSignal,
  ) => Promise<FontMatchingRasterPage>;
  /** ONNX WASM 자산 경로 해석. 기본값은 실구현. 테스트 주입용. */
  resolveWasmAssets?: () => Promise<OrtWasmAssets>;
  /** 워커 스폰/init 실패 시 in-process 폴백 포트 생성. 기본값은 실구현. */
  createFallbackPort?: () => FontMatchingPageInferencePort;
}>;

type PendingInfer = {
  resolve: (
    value: ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>,
  ) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
  signal?: AbortSignal;
  settled: boolean;
};

type Mode = "pending" | "worker" | "fallback";

class FontMatchingInferenceWorkerClient implements FontMatchingPageInferencePort {
  private mode: Mode = "pending";
  private worker: Worker | null = null;
  private initStatus: FontMatchingRuntimeArtifactStatus | null = null;
  private nextId = 0;
  private readonly pendingInfers = new Map<string, PendingInfer>();
  private fallbackPort: FontMatchingPageInferencePort | null = null;
  private exitHandlerRegistered = false;
  private readiness: Promise<boolean> | null = null;
  private disposed = false;
  private readonly artifactDir: string;
  private readonly crossScriptProxyArtifactDir: string;
  private readonly processExitHandler = (): void => {
    void this.terminateWorker();
  };

  constructor(private readonly deps: WorkerClientDependencies) {
    this.artifactDir = resolveFontMatchingArtifactDirSync(deps.paths);
    this.crossScriptProxyArtifactDir = resolveCrossScriptProxyRuntimeDir(
      deps.paths,
    );
  }

  async inferPage(
    request: FontMatchingPageInferenceRequest,
  ): Promise<FontMatchingPageInferenceResult> {
    assertUserPageBoundary(request.boundary);
    if (request.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (!isKoreanLanguageCode(request.targetLanguage)) return emptyResult();
    const ready = await this.ensureWorkerReady();
    if (request.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (!ready) return this.getFallback().inferPage(request);
    const preflight = this.preflight(request);
    if (preflight) return preflight;
    return this.runInferRequest(request);
  }

  /** 준비된 워커에서 공통 게이트(status/catalog snapshot)를 검사해 조기 단축. */
  private preflight(
    request: FontMatchingPageInferenceRequest,
  ): FontMatchingPageInferenceResult | null {
    if (this.initStatus && this.initStatus.state !== "ready") {
      return emptyResult(this.initStatus);
    }
    const selection = this.deps.loadSelection("ko");
    if (!sameCandidateSnapshot(request.candidates, selection.candidates)) {
      return emptyResult(disabled("catalog_mismatch"));
    }
    return null;
  }

  private async runInferRequest(
    request: FontMatchingPageInferenceRequest,
  ): Promise<FontMatchingPageInferenceResult> {
    try {
      const pixelInferenceByBlockId = await this.runInfer(request);
      return {
        ...(this.initStatus ? { runtimeArtifactStatus: this.initStatus } : {}),
        pixelInferenceByBlockId,
      };
    } catch (error) {
      if (request.signal?.aborted) throw error;
      this.deps.reportWarning?.(
        "Font matching pixel inference failed closed for this page",
        error,
      );
      if (!this.worker) this.mode = "fallback";
      return emptyResult(disabled("artifact_verification_failed"));
    }
  }

  private getFallback(): FontMatchingPageInferencePort {
    if (!this.fallbackPort) {
      this.fallbackPort = this.deps.createFallbackPort
        ? this.deps.createFallbackPort()
        : createDefaultFontMatchingPageInferencePort({
            paths: this.deps.paths as AppPaths,
            loadSelection: this.deps.loadSelection as (
              locale: UiLocale,
            ) => AutoMatchActiveCandidateSelection,
            reportWarning: this.deps.reportWarning,
          });
    }
    return this.fallbackPort;
  }

  private settle(
    id: string,
    action: "resolve" | "reject",
    value: unknown,
  ): void {
    const pending = this.pendingInfers.get(id);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pendingInfers.delete(id);
    if (pending.signal) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    if (action === "resolve") {
      pending.resolve(
        value as ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>,
      );
    } else {
      pending.reject(value);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.exitHandlerRegistered) {
      process.removeListener("exit", this.processExitHandler);
      this.exitHandlerRegistered = false;
    }
    const fallbackDisposal = this.fallbackPort?.dispose?.();
    await Promise.all([
      this.terminateWorker(),
      fallbackDisposal ?? Promise.resolve(),
    ]);
  }

  private terminateWorker(): Promise<void> {
    if (!this.worker) return Promise.resolve();
    for (const id of this.pendingInfers.keys()) {
      this.settle(id, "reject", new Error("Font matching worker terminated."));
    }
    const target = this.worker;
    this.worker = null;
    return target.terminate().then(
      () => undefined,
      (_terminateError) => {
        /* error-policy-allow: worker terminate rejection during shutdown is non-actionable */
      },
    );
  }

  private attachWorkerHandlers(target: Worker): void {
    target.on("message", (message: FontMatchingWorkerOutboundMessage) => {
      if (message.type === "ready" || message.type === "init-error") return;
      if (message.type === "infer-done") {
        if (message.ok) {
          this.settle(message.id, "resolve", message.result);
        } else if (message.aborted) {
          this.settle(
            message.id,
            "reject",
            new DOMException("Aborted", "AbortError"),
          );
        } else {
          this.settle(message.id, "reject", deserializeError(message.error));
        }
      }
    });
    target.on("error", (error) => {
      this.deps.reportWarning?.(
        "Font matching worker crashed; falling back to in-process inference.",
        error,
      );
      this.mode = "fallback";
      void this.terminateWorker();
    });
    target.on("exit", (code) => {
      if (this.worker !== target) return;
      this.mode = "fallback";
      void this.terminateWorker();
      if (code !== 0) {
        this.deps.reportWarning?.(
          "Font matching worker exited unexpectedly; falling back to in-process inference.",
          { code },
        );
      }
    });
  }

  private async runInit(
    target: Worker,
  ): Promise<FontMatchingRuntimeArtifactStatus> {
    const id = `init-${this.nextId++}`;
    const wasmAssets = this.deps.resolveWasmAssets
      ? await this.deps.resolveWasmAssets()
      : await resolveFontMatchingOrtWasmAssets(this.deps.paths);
    const installedCandidates =
      this.deps.loadSelection("ko").installedCandidates;
    return new Promise<FontMatchingRuntimeArtifactStatus>((resolve, reject) => {
      const cleanup = (): void => {
        target.off("message", onMessage);
        target.off("error", onError);
        target.off("exit", onExit);
      };
      const onMessage = (message: FontMatchingWorkerOutboundMessage) => {
        if (message.type === "ready" && message.id === id) {
          cleanup();
          resolve(message.status);
        } else if (message.type === "init-error" && message.id === id) {
          cleanup();
          reject(deserializeError(message.error));
        }
      };
      // 워커가 ready/init-error를 보내기 전에 error/exit로 죽으면 Promise가
      // 영원히 pending으로 남아 ensureWorkerReady가 90초 페이지 타임아웃까지
      // 걸리고 그 에러마저 조용히 삼켜지므로, 여기서 즉시 reject해
      // ensureWorkerReady의 catch → in-process 폴백으로 빠진다.
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number): void => {
        cleanup();
        reject(
          new Error(
            `Font matching worker exited before initialization completed: ${code}`,
          ),
        );
      };
      target.on("message", onMessage);
      target.on("error", onError);
      target.on("exit", onExit);
      target.postMessage({
        type: "init",
        id,
        artifactDir: this.artifactDir,
        crossScriptProxyArtifactDir: this.crossScriptProxyArtifactDir,
        wasmAssets,
        installedCandidates,
      });
    });
  }

  private async ensureWorkerReady(): Promise<boolean> {
    if (this.disposed) {
      throw new Error("Font matching inference port has been disposed.");
    }
    if (this.mode === "fallback") return false;
    if (this.mode === "worker") return true;
    this.readiness ??= this.initializeWorker().finally(() => {
      this.readiness = null;
    });
    return this.readiness;
  }

  private async initializeWorker(): Promise<boolean> {
    try {
      const resolveWorkerScript =
        this.deps.resolveWorkerScript ??
        (() => require.resolve("./fontMatchingInferenceWorker.js"));
      const spawned = new Worker(resolveWorkerScript());
      this.attachWorkerHandlers(spawned);
      this.worker = spawned;
      this.initStatus = await this.runInit(spawned);
      if (this.worker !== spawned) {
        this.mode = "fallback";
        return false;
      }
      if (this.disposed) {
        await this.terminateWorker();
        return false;
      }
      if (this.initStatus.state !== "ready") {
        // 런타임이 disabled(missing_artifact/catalog_mismatch/...)면 추론은
        // 조용히 빈 결과로 빠지므로, 원인을 최초 1회 기록해 사용자가 "왜 안
        // 적용되나"를 로그에서 추적할 수 있게 한다. ensureWorkerReady는 한 번만
        // init하므로 중복 경고 없음.
        this.deps.reportWarning?.(
          "Font matching runtime is disabled; auto font matching will not apply.",
          this.initStatus,
        );
      }
      this.mode = "worker";
      if (!this.exitHandlerRegistered) {
        this.exitHandlerRegistered = true;
        process.once("exit", this.processExitHandler);
      }
      return true;
    } catch (error) {
      this.deps.reportWarning?.(
        "Font matching worker could not be started; falling back to in-process inference.",
        error,
      );
      await this.terminateWorker();
      this.mode = "fallback";
      return false;
    }
  }

  private runInfer(
    request: FontMatchingPageInferenceRequest,
  ): Promise<ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>> {
    const id = `infer-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.worker?.postMessage({ type: "cancel", id });
        this.settle(id, "reject", new DOMException("Aborted", "AbortError"));
      };
      const pending: PendingInfer = {
        resolve,
        reject,
        onAbort,
        signal: request.signal,
        settled: false,
      };
      this.pendingInfers.set(id, pending);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      void this.decodeAndPost(id, request, onAbort);
    });
  }

  private async decodeAndPost(
    id: string,
    request: FontMatchingPageInferenceRequest,
    onAbort: () => void,
  ): Promise<void> {
    try {
      // 래스터 디코드는 메인에서(nativeImage). BGRA 버퍼를 transferable로 전달해
      // 워커에 복사 없이 넘긴다.
      const loadRaster = this.deps.loadRaster ?? loadFontMatchingPageRaster;
      const raster = await loadRaster(request.page, request.signal);
      if (!this.worker) {
        this.settle(
          id,
          "reject",
          new Error("Font matching worker is not running."),
        );
        return;
      }
      const transferBuffer = raster.bgra.buffer as ArrayBuffer;
      this.worker.postMessage(
        {
          type: "infer",
          id,
          page: request.page,
          blocks: request.blocks,
          candidates: request.candidates,
          boundary: request.boundary,
          qaPageRelativeRoleReroute: request.qaPageRelativeRoleReroute === true,
          raster,
        },
        [transferBuffer],
      );
    } catch (error) {
      request.signal?.removeEventListener("abort", onAbort);
      this.settle(id, "reject", error);
    }
  }
}

export function createWorkerFontMatchingPageInferencePort(
  dependencies: WorkerClientDependencies,
): FontMatchingPageInferencePort {
  return new FontMatchingInferenceWorkerClient(dependencies);
}

function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  return error;
}
