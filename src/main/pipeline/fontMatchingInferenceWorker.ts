/**
 * Font matching ONNX inference worker (node:worker_threads).
 *
 * 폰트 매칭 픽셀 추론(crop/Otsu/flood-fill/CC/chamfer/Lanczos 전처리 + ONNX WASM
 * 실행)은 동기 heavy 작업이라 메인 이벤트 루프에서 실행하면 페이지 추론 중
 * IPC(취소/진행/탐색)가 막혀 앱이 멈춘다. 이 워커는 추론 본체를 전용 스레드로
 * 오프로드해 메인이 IPC를 계속 서비스하도록 한다.
 *
 * 워커는 sealed 추론 모듈의 이미 export 된 진입점(loadFontMatchingRuntimeModel,
 * inferFontMatchingPagePixels)을 그대로 호출한다 — ONNX 세션 캐시/prototype
 * 캐시/ort.env.wasm 설정(numThreads=1, proxy=false)은 워커 스레드 컨텍스트에서
 * 초기화된다. 래스터 디코드(nativeImage, Electron 메인 전용)는 메인에서 수행해
 * BGRA 버퍼를 transferable로 전달받으므로 워커는 nativeImage를 필요로 하지 않는다.
 *
 * 메시지 프로토콜:
 *   init   { type:"init", id, artifactDir, wasmAssets, installedCandidates, allowQaOnlyRuntime? }
 *          -> { type:"ready", id, status } | { type:"init-error", id, error }
 *   infer  { type:"infer", id, page, blocks, candidates, boundary, raster }
 *          -> { type:"infer-done", id, ok:true, result:Map }
 *           | { type:"infer-done", id, ok:false, aborted:boolean, error }
 *   cancel { type:"cancel", id } -> 해당 id의 AbortController 중단
 */
import { parentPort } from "node:worker_threads";
import {
  inferFontExpressionPage,
  loadFontExpressionModel,
} from "./fontMatchingExpressionRuntime";
import type { MangaPage } from "../../shared/libraryTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type {
  FontMatchingInferenceInputBoundary,
  FontMatchingPageInferenceBlock,
  VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";
import type { FontMatchingRuntimeArtifactStatus } from "./fontMatchingRuntimeArtifactStatus";
import type { InstalledAutoMatchCandidate } from "./autoMatchActiveCatalogTypes";
import type {
  FontMatchingExecutionBackend,
  OrtWasmAssets,
  FontMatchingRuntimeModel,
} from "./fontMatchingPagePixelInference";
import {
  loadFontMatchingRuntimeModel,
  inferFontMatchingPagePixels,
} from "./fontMatchingPagePixelInference";
import {
  inferCrossScriptProxyPage,
  loadCrossScriptProxyRuntimeModel,
  type CrossScriptProxyRuntimeModel,
} from "./fontMatchingCrossScriptProxyRuntime";

export type FontMatchingWorkerInitMessage = Readonly<{
  type: "init";
  id: string;
  artifactDir: string;
  crossScriptProxyArtifactDir: string;
  wasmAssets: OrtWasmAssets;
  installedCandidates: readonly InstalledAutoMatchCandidate[];
  allowQaOnlyRuntime?: boolean;
}>;

export type FontMatchingWorkerInferMessage = Readonly<{
  type: "infer";
  id: string;
  page: MangaPage;
  blocks: readonly FontMatchingPageInferenceBlock[];
  candidates: readonly AutomaticFontCandidate[];
  boundary: FontMatchingInferenceInputBoundary;
  qaPageRelativeRoleReroute?: boolean;
  raster: FontMatchingRasterPage;
}>;

export type FontMatchingWorkerCancelMessage = Readonly<{
  type: "cancel";
  id: string;
}>;

export type FontMatchingWorkerInboundMessage =
  | FontMatchingWorkerInitMessage
  | FontMatchingWorkerInferMessage
  | FontMatchingWorkerCancelMessage;

export type FontMatchingWorkerReadyMessage = Readonly<{
  type: "ready";
  id: string;
  status: FontMatchingRuntimeArtifactStatus;
  backend?: FontMatchingExecutionBackend;
}>;

export type FontMatchingWorkerInitErrorMessage = Readonly<{
  type: "init-error";
  id: string;
  error: SerializedError;
}>;

export type FontMatchingWorkerInferDoneMessage = Readonly<{
  type: "infer-done";
  id: string;
  ok: true;
  result: ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>;
}>;

export type FontMatchingWorkerInferFailedMessage = Readonly<{
  type: "infer-done";
  id: string;
  ok: false;
  aborted: boolean;
  error: SerializedError;
}>;

export type FontMatchingWorkerOutboundMessage =
  | FontMatchingWorkerReadyMessage
  | FontMatchingWorkerInitErrorMessage
  | FontMatchingWorkerInferDoneMessage
  | FontMatchingWorkerInferFailedMessage;

export type SerializedError = Readonly<{ name: string; message: string }>;

const port = parentPort;
if (!port) {
  // 워커 컨텍스트가 아니면 즉시 실패 — 잘못된 로드 방식 가드.
  throw new Error(
    "fontMatchingInferenceWorker must be spawned as a worker_threads worker.",
  );
}

let runtimeModel: FontMatchingRuntimeModel | null = null;
let crossScriptProxyModel: CrossScriptProxyRuntimeModel | null = null;
let expressionModel: Awaited<
  ReturnType<typeof loadFontExpressionModel>
> | null = null;
const abortControllers = new Map<string, AbortController>();

port.on("message", (message: FontMatchingWorkerInboundMessage) => {
  if (message.type === "init") {
    void handleInit(message);
  } else if (message.type === "infer") {
    void handleInfer(message);
  } else if (message.type === "cancel") {
    abortControllers.get(message.id)?.abort();
  }
});

async function handleInit(
  message: FontMatchingWorkerInitMessage,
): Promise<void> {
  try {
    // A client normally initializes once. Release this additive CPU session
    // before a repeated init so a failed reload cannot retain stale evidence.
    const previousExpressionModel = expressionModel;
    expressionModel = null;
    await previousExpressionModel?.release();
    const result = await loadFontMatchingRuntimeModel({
      artifactDir: message.artifactDir,
      installedCandidates: message.installedCandidates,
      wasmAssets: message.wasmAssets,
      allowQaOnlyRuntime: message.allowQaOnlyRuntime ?? false,
      // Built-in font files live inside app.asar, which a worker_threads
      // worker cannot read (Electron's asar `fs` patches are main-process
      // only). The main process already verified each installed asset's
      // hash/size against the catalog via resolveAndVerifyActiveFontAsset when
      // building the candidate snapshot, so trust that here and only run the
      // structural catalog check. Re-hashing would silently fail with
      // catalog_mismatch and disable auto font matching in the packaged app.
      reverifyInstalledAssetBytes: false,
    });
    if (!result.model) {
      runtimeModel = null;
      crossScriptProxyModel = null;
      post({ type: "ready", id: message.id, status: result.status });
      return;
    }
    runtimeModel = result.model;
    crossScriptProxyModel = await loadCrossScriptProxyRuntimeModel(
      message.crossScriptProxyArtifactDir,
    );
    if (
      crossScriptProxyModel.candidateOrderSha256 !==
      runtimeModel.status.candidateOrderSha256
    ) {
      throw new Error(
        "Cross-script proxy and R33 candidate catalogs do not match.",
      );
    }
    expressionModel = await loadFontExpressionModel();
    post({
      type: "ready",
      id: message.id,
      status: result.status,
      backend: result.model.executionBackend,
    });
  } catch (error) {
    runtimeModel = null;
    crossScriptProxyModel = null;
    post({ type: "init-error", id: message.id, error: serializeError(error) });
  }
}

async function handleInfer(
  message: FontMatchingWorkerInferMessage,
): Promise<void> {
  const controller = new AbortController();
  abortControllers.set(message.id, controller);
  try {
    if (!runtimeModel) {
      throw new Error(
        "Font matching worker received an infer request before a successful init.",
      );
    }
    // 래스터는 메인에서 디코드해 transferable로 전달됨 — 워커는 디코드 없이
    // 전달받은 BGRA 버퍼를 그대로 사용한다.
    const cachedRaster = message.raster;
    const loadRaster = async (): Promise<FontMatchingRasterPage> =>
      cachedRaster;
    const result = await inferFontMatchingPagePixels({
      page: message.page,
      blocks: message.blocks,
      candidates: message.candidates,
      boundary: message.boundary,
      qaPageRelativeRoleReroute: message.qaPageRelativeRoleReroute === true,
      signal: controller.signal,
      model: runtimeModel,
      loadRaster,
    });
    const proxyByBlockId = crossScriptProxyModel
      ? await inferCrossScriptProxyPage({
          blocks: message.blocks,
          candidates: message.candidates,
          existingRows: result,
          model: crossScriptProxyModel,
          raster: cachedRaster,
          signal: controller.signal,
        })
      : new Map();
    const combined = new Map(result);
    for (const [blockId, crossScriptProxy] of proxyByBlockId) {
      const row = result.get(blockId);
      if (row) combined.set(blockId, { ...row, crossScriptProxy });
    }
    const expressive = expressionModel
      ? await inferFontExpressionPage({
          session: expressionModel,
          blocks: message.blocks,
          rows: combined,
          raster: cachedRaster,
          signal: controller.signal,
        })
      : combined;
    post({ type: "infer-done", id: message.id, ok: true, result: expressive });
  } catch (error) {
    post({
      type: "infer-done",
      id: message.id,
      ok: false,
      aborted: controller.signal.aborted,
      error: serializeError(error),
    });
  } finally {
    abortControllers.delete(message.id);
  }
}

function post(message: FontMatchingWorkerOutboundMessage): void {
  port?.postMessage(message);
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}
