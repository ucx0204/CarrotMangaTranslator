/* eslint-disable max-lines -- sealed ONNX loading and inference stay co-located for auditability */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";
import type { MangaPage } from "../../shared/libraryTypes";
import type {
  FontMatchingSemanticRole,
  FontMatchingSourceStyleV2,
  FontMatchingTreatmentV2,
  FontMatchRolePredictionV2,
  RankedFontCandidateV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { UiLocale } from "../../shared/uiLocales";
import { isKoreanLanguageCode } from "../../shared/translationLanguages";
import type { AppPaths } from "../appPaths";
import { loadFontMatchingPageRaster } from "../fontMatchingPageImage";
import { buildAutomaticFontPageConsistencyPlan } from "./automaticFontMatchingV2PageConsistency";
import { resolveAutomaticFontCalibratedPixelWinner } from "./automaticFontMatchingV2PageFamily";
import {
  ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
  ONNXRUNTIME_WEB_WASM_BINARY_FILE,
  ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  ONNXRUNTIME_WEB_WASM_MODULE_BYTES,
  ONNXRUNTIME_WEB_WASM_MODULE_FILE,
  ONNXRUNTIME_WEB_WASM_MODULE_SHA256,
  ONNXRUNTIME_WEB_VERSION,
} from "../bubbleLayout/constants";
import type {
  AutoMatchActiveCandidateSelection,
  InstalledAutoMatchCandidate,
} from "./autoMatchActiveCatalogTypes";
import { resolveFontMatchingV2CatalogVersion } from "./automaticFontMatchingV2Catalog";
import { markRetiredAutomaticFontCandidates } from "./automaticFontMatchingRetiredFonts";
import {
  readVerifiedRuntimeArtifactBundle,
  type VerifiedRuntimeArtifactBundle,
} from "./fontMatchingRuntimeArtifactBundleLoader";
import {
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2,
  FONT_MATCHING_SELECTION_CALIBRATION_FILE,
} from "./fontMatchingRuntimeArtifactContract";
import { resolveFontMatchingArtifactDirSync } from "./fontMatchingRuntimePaths";
import {
  loadFontMatchingRuntimeArtifactStatus,
  type FontMatchingRuntimeArtifactStatus,
} from "./fontMatchingRuntimeArtifactStatus";
import {
  FONT_MATCHING_PIXEL_INPUT_SIZE,
  FONT_MATCHING_PIXEL_VIEW_COUNT,
  prepareFontMatchingBlockViews,
  type FontMatchingGlyphMorphologyV1,
  type FontMatchingRasterPage,
} from "./fontMatchingPagePixelPreprocessing";
import {
  type FontMatchingInferenceInputBoundary,
  type FontMatchingPageInferenceBlock,
  type FontMatchingPageInferencePort,
  type FontMatchingPageInferenceRequest,
  type FontMatchingPageInferenceResult,
  type VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";
import {
  applySupervisedFontSelectionCalibration,
  isFontMatchingSelectionCalibrationDeploymentReady,
} from "./fontMatchingSelectionCalibration";
import {
  parseFontMatchingSelectionCalibration,
  reconstructFontMatchingSourceRuntimeContractSha256,
  type FontMatchingSelectionCalibration,
} from "./fontMatchingSelectionCalibrationContract";
import {
  buildFontMatchingSelectionFeatureSet,
  type FontMatchingPrototypeBag,
} from "./fontMatchingSelectionCalibrationFeatures";
import { resolvePixelCandidateEligibility } from "./fontMatchingPixelCandidateEligibility";
import { readFontMatchingOcrGeometryDirection } from "./fontMatchingOcrGeometryDirection";
import {
  applyFontMatchingPageRelativePeerScorePreference,
  buildFontMatchingPageRelativeRoleQaPlan,
  FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY,
  projectFontMatchingPageRelativeRole,
  shouldRevertPageRelativeQaForApplyRate,
  type FontMatchingPageRelativeRoleQaPlanRow,
} from "./fontMatchingPageRelativeRoleQa";

const ENCODER_FILE = "encoder.onnx";
const RANKER_FILE = "ranker.onnx";
const PROTOTYPE_FILE = "prototype-features.f32";
const LEGACY_ENCODER_BATCH_SIZE = 24;
const LEGACY_RANKER_BATCH_SIZE = Number.MAX_SAFE_INTEGER;

const RUNTIME_ROLE_VALUES = [
  "dialogue",
  "narration",
  "thought",
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
  "other",
] as const;

const RUNTIME_STYLE_FIELDS = [
  "serifness",
  "weight",
  "width",
  "roundness",
  "stroke_contrast",
  "handwritten",
  "angularity",
  "irregularity",
  "slant",
  "energy",
] as const;

const RUNTIME_TREATMENTS = {
  distortion: [
    "none",
    "slant",
    "perspective",
    "warp",
    "wave",
    "jitter",
    "other",
    "unknown",
  ],
  fill: ["solid", "gradient", "pattern", "inverse", "transparent", "unknown"],
  orientation: ["horizontal", "vertical", "mixed", "unknown"],
  outline: ["none", "single", "double", "multiple", "unknown"],
  shadow: ["none", "hard", "soft", "multiple", "unknown"],
} as const;

const LEGACY_RANKER_OUTPUT_NAMES = [
  "candidate_scores",
  "none_logits",
  "role_logits",
  "style_logits",
  "treatment_distortion_logits",
  "treatment_fill_logits",
  "treatment_orientation_logits",
  "treatment_outline_logits",
  "treatment_shadow_logits",
  "view_gate_weights",
] as const;

const HYBRID_RANKER_OUTPUT_NAMES = [
  "candidate_scores",
  "body_candidate_scores",
  "variant_candidate_scores",
  "none_logits",
  "role_logits",
  "style_logits",
  "treatment_distortion_logits",
  "treatment_fill_logits",
  "treatment_orientation_logits",
  "treatment_outline_logits",
  "treatment_shadow_logits",
  "view_gate_weights",
] as const;

type HybridScoreRouting = Readonly<{
  bodyRoles: ReadonlySet<FontMatchingSemanticRole>;
  bodyOutput: "body_candidate_scores";
  variantOutput: "variant_candidate_scores";
  selectionFeatureDim: number;
}>;

type FloatTensorLike = Readonly<{
  data: unknown;
  dims: readonly number[];
  dispose?: () => void;
}>;

type GatheredRankerOutput = {
  data: Float32Array;
  tail: readonly number[];
  width: number;
};

export type FontMatchingOnnxSession = Readonly<{
  inputNames: readonly string[];
  outputNames: readonly string[];
  run: (
    feeds: Readonly<Record<string, unknown>>,
    fetches?: readonly string[],
    options?: { terminate: boolean },
  ) => Promise<Readonly<Record<string, FloatTensorLike>>>;
}>;

export type FontMatchingRuntimeModel = Readonly<{
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>;
  encoder: FontMatchingOnnxSession;
  ranker: FontMatchingOnnxSession;
  createFloatTensor: (data: Float32Array, dims: readonly number[]) => unknown;
  candidateIds: readonly string[];
  encoderBatchSize: number;
  featureDim: number;
  selectionFeatureDim: number;
  prototypeCount: number;
  prototypeFeatures: Float32Array;
  selectionPrototypeFeatures: Float32Array;
  prototypeBags: readonly FontMatchingPrototypeBag[];
  rankerOutputNames: readonly string[];
  rankerBatchSize: number;
  scoreRouting: HybridScoreRouting | null;
  rendererHash: string;
  selectionCalibration: FontMatchingSelectionCalibration;
  qaOnlyRuntime: boolean;
  failedCalibrationQualityAccepted?: boolean;
}>;

type RuntimeLoadResult =
  | Readonly<{
      status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>;
      model: FontMatchingRuntimeModel;
    }>
  | Readonly<{
      status: Extract<FontMatchingRuntimeArtifactStatus, { state: "disabled" }>;
      model: null;
    }>;

export type OrtWasmAssets = Readonly<{
  wasmBinaryPath: string;
  wasmModulePath: string;
}>;

type RuntimeModelLoadOptions = Readonly<{
  artifactDir: string;
  installedCandidates: readonly InstalledAutoMatchCandidate[];
  wasmAssets: OrtWasmAssets;
  allowQaOnlyRuntime?: boolean;
  reverifyInstalledAssetBytes?: boolean;
}>;

type RuntimeContract = Readonly<{
  featureDim: number;
  encoderBatchSize: number;
  selectionFeatureDim: number;
  prototypeCount: number;
  prototypeBags: readonly FontMatchingPrototypeBag[];
  catalogRegistrySha256: string;
  rendererHash: string;
  rankerOutputNames: readonly string[];
  rankerBatchSize: number;
  scoreRouting: HybridScoreRouting | null;
}>;

type PortDependencies = Readonly<{
  artifactDir: string;
  allowQaOnlyRuntime?: boolean;
  loadSelection: (locale: UiLocale) => AutoMatchActiveCandidateSelection;
  resolveWasmAssets: () => Promise<OrtWasmAssets>;
  loadRaster: (
    page: MangaPage,
    signal?: AbortSignal,
  ) => Promise<FontMatchingRasterPage>;
  reportWarning?: (message: string, detail: unknown) => void;
}>;

const sessionCache = new Map<
  string,
  Promise<
    Readonly<{
      encoder: FontMatchingOnnxSession;
      ranker: FontMatchingOnnxSession;
    }>
  >
>();
const prototypeCache = new Map<string, Float32Array>();
let configuredWasmPaths: OrtWasmAssets | null = null;

export function createFontMatchingPageInferencePort(
  dependencies: PortDependencies,
): FontMatchingPageInferencePort {
  const preparedByLocale = new Map<UiLocale, Promise<RuntimeLoadResult>>();
  return {
    async inferPage(request) {
      assertUserPageBoundary(request.boundary);
      throwIfAborted(request.signal);
      if (!isKoreanLanguageCode(request.targetLanguage)) return emptyResult();
      let pending = preparedByLocale.get("ko");
      if (!pending) {
        pending = prepareRuntimeForPort(dependencies, "ko");
        preparedByLocale.set("ko", pending);
      }
      const prepared = await pending;
      if (prepared.status.state !== "ready" || !prepared.model) {
        return emptyResult(prepared.status);
      }
      const selection = dependencies.loadSelection("ko");
      if (!sameCandidateSnapshot(request.candidates, selection.candidates)) {
        return emptyResult(disabled("catalog_mismatch"));
      }
      try {
        return {
          runtimeArtifactStatus: prepared.status,
          pixelInferenceByBlockId: await inferFontMatchingPagePixels({
            ...request,
            model: prepared.model,
            loadRaster: dependencies.loadRaster,
          }),
        };
      } catch (error) {
        if (request.signal?.aborted) throw error;
        dependencies.reportWarning?.(
          "Font matching pixel inference failed closed for this page",
          error,
        );
        return emptyResult(disabled("artifact_verification_failed"));
      }
    },
  };
}

export function createDefaultFontMatchingPageInferencePort({
  paths,
  loadSelection,
  reportWarning,
}: {
  paths: AppPaths;
  loadSelection: (locale: UiLocale) => AutoMatchActiveCandidateSelection;
  reportWarning?: (message: string, detail: unknown) => void;
}): FontMatchingPageInferencePort {
  return createFontMatchingPageInferencePort({
    artifactDir: resolveFontMatchingArtifactDirSync(paths),
    loadSelection,
    resolveWasmAssets: () => resolveFontMatchingOrtWasmAssets(paths),
    loadRaster: loadFontMatchingPageRaster,
    reportWarning,
  });
}

async function prepareRuntimeForPort(
  dependencies: PortDependencies,
  locale: UiLocale,
): Promise<RuntimeLoadResult> {
  try {
    const selection = dependencies.loadSelection(locale);
    return await loadFontMatchingRuntimeModel({
      artifactDir: dependencies.artifactDir,
      installedCandidates: selection.installedCandidates,
      wasmAssets: await dependencies.resolveWasmAssets(),
      allowQaOnlyRuntime: dependencies.allowQaOnlyRuntime ?? false,
    });
  } catch (error) {
    dependencies.reportWarning?.(
      "Font matching runtime artifact could not be prepared",
      error,
    );
    return { status: disabled("artifact_verification_failed"), model: null };
  }
}

export async function loadFontMatchingRuntimeModel({
  artifactDir,
  installedCandidates,
  wasmAssets,
  allowQaOnlyRuntime = false,
  reverifyInstalledAssetBytes = true,
}: RuntimeModelLoadOptions): Promise<RuntimeLoadResult> {
  const status = await loadFontMatchingRuntimeArtifactStatus({
    artifactDir,
    installedCandidates,
    allowQaOnlyRuntime,
    reverifyInstalledAssetBytes,
  });
  if (status.state !== "ready") return { status, model: null };
  try {
    return await buildFontMatchingRuntimeModel(
      artifactDir,
      wasmAssets,
      status,
      allowQaOnlyRuntime,
    );
  } catch (_error) {
    return { status: disabled("artifact_verification_failed"), model: null };
  }
}

async function buildFontMatchingRuntimeModel(
  artifactDir: string,
  wasmAssets: OrtWasmAssets,
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>,
  allowQaOnlyRuntime: boolean,
): Promise<RuntimeLoadResult> {
  const bundle = await readRuntimeBundle(artifactDir, allowQaOnlyRuntime);
  const prototypeBytes = requiredBytes(bundle.assetBytes, PROTOTYPE_FILE);
  const contract = parseRuntimeInferenceContract(
    bundle.contract,
    status,
    bundle.activeCatalog.sourceRecords.deploymentRenderBankManifestSha256,
    prototypeBytes.byteLength,
  );
  if (!contract) return { status: disabled("invalid_contract"), model: null };
  const selectionCalibration = parseVerifiedSelectionCalibration(
    bundle,
    status,
    contract,
  );
  if (!selectionCalibration) return invalidRuntimeLoad();
  const prototypeFeatures = readPrototypeFeatures(
    prototypeBytes,
    contract,
    bundle.assets[PROTOTYPE_FILE]?.sha256 ?? "",
  );
  const sessions = await getOrCreateSessions({
    encoderBytes: requiredBytes(bundle.assetBytes, ENCODER_FILE),
    encoderSha256: bundle.assets[ENCODER_FILE]?.sha256 ?? "",
    rankerBytes: requiredBytes(bundle.assetBytes, RANKER_FILE),
    rankerSha256: bundle.assets[RANKER_FILE]?.sha256 ?? "",
    wasmAssets,
  });
  assertSessionNames(sessions.encoder, ["pixel_values"], ["image_features"]);
  assertSessionNames(
    sessions.ranker,
    ["views", "prototype_features"],
    contract.rankerOutputNames,
  );
  const selectionPrototypeFeatures = selectFeaturePrefixRows(
    prototypeFeatures,
    contract.prototypeCount,
    contract.featureDim,
    contract.selectionFeatureDim,
  );
  const model: FontMatchingRuntimeModel = {
    status,
    ...sessions,
    createFloatTensor: (data, dims) =>
      new ort.Tensor("float32", data, [...dims]),
    candidateIds: [...status.candidateIds],
    encoderBatchSize: contract.encoderBatchSize,
    featureDim: contract.featureDim,
    selectionFeatureDim: contract.selectionFeatureDim,
    prototypeCount: contract.prototypeCount,
    prototypeFeatures,
    selectionPrototypeFeatures,
    prototypeBags: contract.prototypeBags,
    rankerOutputNames: contract.rankerOutputNames,
    rankerBatchSize: contract.rankerBatchSize,
    scoreRouting: contract.scoreRouting,
    rendererHash: contract.rendererHash,
    selectionCalibration,
    qaOnlyRuntime: bundle.qaOnly,
    failedCalibrationQualityAccepted: bundle.failedCalibrationQualityAccepted,
  };
  return { status, model };
}

function invalidRuntimeLoad(): RuntimeLoadResult {
  return { status: disabled("invalid_contract"), model: null };
}

function readRuntimeBundle(
  artifactDir: string,
  allowQaOnlyRuntime: boolean,
): Promise<VerifiedRuntimeArtifactBundle> {
  return readVerifiedRuntimeArtifactBundle(resolve(artifactDir), {
    allowQaOnlyRuntime,
  });
}

function parseVerifiedSelectionCalibration(
  bundle: VerifiedRuntimeArtifactBundle,
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>,
  contract: RuntimeContract,
): FontMatchingSelectionCalibration | null {
  const sourceRuntimeContractSha256 =
    reconstructFontMatchingSourceRuntimeContractSha256(
      bundle.contract,
      bundle.contractJson,
    );
  if (!sourceRuntimeContractSha256) return null;
  const calibration = parseFontMatchingSelectionCalibration(
    requiredBytes(bundle.assetBytes, FONT_MATCHING_SELECTION_CALIBRATION_FILE),
    {
      model_version: status.modelVersion,
      runtime_contract_sha256: sourceRuntimeContractSha256,
      candidate_order_sha256: status.candidateOrderSha256,
      encoder_sha256: bundle.assets[ENCODER_FILE]?.sha256 ?? "",
      ranker_sha256: bundle.assets[RANKER_FILE]?.sha256 ?? "",
      prototype_features_sha256: bundle.assets[PROTOTYPE_FILE]?.sha256 ?? "",
      catalog_registry_sha256: contract.catalogRegistrySha256,
    },
  );
  return calibration &&
    isFontMatchingSelectionCalibrationDeploymentReady(calibration, {
      allowFailedReleaseQuality:
        bundle.qaOnly || bundle.failedCalibrationQualityAccepted,
    })
    ? calibration
    : null;
}

export async function inferFontMatchingPagePixels({
  page,
  blocks,
  candidates,
  boundary,
  qaPageRelativeRoleReroute = false,
  signal,
  model,
  loadRaster,
}: FontMatchingPageInferenceRequest & {
  model: FontMatchingRuntimeModel;
  loadRaster: (
    page: MangaPage,
    signal?: AbortSignal,
  ) => Promise<FontMatchingRasterPage>;
}): Promise<ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>> {
  assertUserPageBoundary(boundary);
  assertInferenceCatalog(model, candidates);
  throwIfAborted(signal);
  if (blocks.length === 0) return new Map();
  const raster = await loadRaster(page, signal);
  if (raster.width !== page.width || raster.height !== page.height) {
    throw new Error("Original-page dimensions drifted before font inference.");
  }
  // 전체 페이지 디코드 직후 한 번 양보해 메인 이벤트 루프가 IPC/취소를 서비스.
  await yieldToEventLoop();
  // 블록별 픽셀 전처리(crop/Otsu/flood-fill/CC/chamfer/Lanczos)는 동기 heavy
  // 작업이다. 매 블록마다 양보하지 않으면 페이지 폰트매칭 중 메인 스레드가
  // IPC를 서비스하지 못해 앱이 멈춘다. 한 블록 단위로 양보해 응답성을 유지.
  const prepared: {
    block: (typeof blocks)[number];
    views: NonNullable<ReturnType<typeof prepareFontMatchingBlockViews>>;
  }[] = [];
  for (const block of blocks) {
    throwIfAborted(signal);
    const views = prepareFontMatchingBlockViews(
      raster,
      block.item.bbox,
      signal,
    );
    if (views) {
      prepared.push({ block, views });
    }
    await yieldToEventLoop();
  }
  if (prepared.length === 0) return new Map();
  const features = await encodeBlockViews(model, prepared, signal);
  const outputs = await runRanker(model, features, prepared.length, signal);
  try {
    return buildPixelInferenceRows({
      blocks: prepared.map(({ block }) => block),
      glyphMorphologies: prepared.map(({ views }) => views.glyphMorphology),
      candidates,
      model,
      features,
      outputs,
      pageId: page.id,
      boundary,
      qaPageRelativeRoleReroute,
    });
  } finally {
    disposeOutputs(outputs);
  }
}

/**
 * 메인 프로세스의 동기 heavy 작업 사이에 이벤트 루프로 양보한다. 폰트매칭 픽셀
 * 전처리는 메인 스레드에서 동기로 실행되므로, 블록 사이에 양보하지 않으면
 * 페이지 추론 중 IPC(취소/진행/탐색)가 막혀 앱이 멈춘다. setImmediate는
 * I/O/타이머 콜백을 먼저 drain시키므로 IPC 응답성을 유지한다.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function encodeBlockViews(
  model: FontMatchingRuntimeModel,
  prepared: readonly {
    views: { pixelValues: Float32Array };
  }[],
  signal?: AbortSignal,
): Promise<Float32Array> {
  const featureRows = prepared.length * FONT_MATCHING_PIXEL_VIEW_COUNT;
  const features = new Float32Array(featureRows * model.featureDim);
  const viewSize = 3 * FONT_MATCHING_PIXEL_INPUT_SIZE ** 2;
  for (let start = 0; start < featureRows; start += model.encoderBatchSize) {
    throwIfAborted(signal);
    const end = Math.min(featureRows, start + model.encoderBatchSize);
    const batch = new Float32Array((end - start) * viewSize);
    for (let row = start; row < end; row += 1) {
      const blockIndex = Math.floor(row / FONT_MATCHING_PIXEL_VIEW_COUNT);
      const viewIndex = row % FONT_MATCHING_PIXEL_VIEW_COUNT;
      const source = prepared[blockIndex]?.views.pixelValues;
      if (!source) throw new Error("Font matching view inventory drifted.");
      batch.set(
        source.subarray(viewIndex * viewSize, (viewIndex + 1) * viewSize),
        (row - start) * viewSize,
      );
    }
    const input = model.createFloatTensor(batch, [
      end - start,
      3,
      FONT_MATCHING_PIXEL_INPUT_SIZE,
      FONT_MATCHING_PIXEL_INPUT_SIZE,
    ]);
    const output = await runSession(
      model.encoder,
      { pixel_values: input },
      ["image_features"],
      signal,
    );
    try {
      const encoded = requireFloatTensor(
        output.image_features,
        [end - start, model.featureDim],
        "encoder.image_features",
      );
      features.set(encoded, start * model.featureDim);
    } finally {
      disposeTensor(input);
      disposeOutputs(output);
    }
  }
  return features;
}

async function runRanker(
  model: FontMatchingRuntimeModel,
  features: Float32Array,
  blockCount: number,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, FloatTensorLike>>> {
  if (
    blockCount <= model.rankerBatchSize ||
    model.rankerBatchSize === LEGACY_RANKER_BATCH_SIZE
  ) {
    return runRankerBatch(model, features, blockCount, signal);
  }
  const gathered = new Map<string, GatheredRankerOutput>();
  const featureRowWidth = FONT_MATCHING_PIXEL_VIEW_COUNT * model.featureDim;
  for (let start = 0; start < blockCount; start += model.rankerBatchSize) {
    const end = Math.min(blockCount, start + model.rankerBatchSize);
    const batch = await runRankerBatch(
      model,
      features.subarray(start * featureRowWidth, end * featureRowWidth),
      end - start,
      signal,
    );
    try {
      gatherRankerBatchOutputs({
        batch,
        batchSize: end - start,
        blockCount,
        gathered,
        outputNames: model.rankerOutputNames,
        start,
      });
    } finally {
      disposeOutputs(batch);
    }
  }
  return assembleRankerOutputs(gathered, model.rankerOutputNames, blockCount);
}

function gatherRankerBatchOutputs({
  batch,
  batchSize,
  blockCount,
  gathered,
  outputNames,
  start,
}: {
  batch: Readonly<Record<string, FloatTensorLike>>;
  batchSize: number;
  blockCount: number;
  gathered: Map<string, GatheredRankerOutput>;
  outputNames: readonly string[];
  start: number;
}): void {
  for (const name of outputNames) {
    const output = requireRankerBatchOutput(batch[name], batchSize, name);
    const target = getRankerOutputTarget(gathered, name, output, blockCount);
    target.data.set(output.data, start * output.width);
  }
}

function requireRankerBatchOutput(
  tensor: FloatTensorLike | undefined,
  batchSize: number,
  name: string,
): GatheredRankerOutput {
  if (
    !tensor ||
    !(tensor.data instanceof Float32Array) ||
    tensor.dims[0] !== batchSize ||
    tensor.dims.length < 1 ||
    tensor.data.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`ranker.${name} batched tensor drifted.`);
  }
  const tail = tensor.dims.slice(1);
  const width = tail.reduce((product, dimension) => product * dimension, 1);
  if (tensor.data.length !== batchSize * width) {
    throw new Error(`ranker.${name} batched tensor size drifted.`);
  }
  return { data: tensor.data, tail, width };
}

function getRankerOutputTarget(
  gathered: Map<string, GatheredRankerOutput>,
  name: string,
  output: GatheredRankerOutput,
  blockCount: number,
): GatheredRankerOutput {
  const existing = gathered.get(name);
  if (!existing) {
    const target = {
      data: new Float32Array(blockCount * output.width),
      tail: output.tail,
      width: output.width,
    };
    gathered.set(name, target);
    return target;
  }
  if (
    existing.width !== output.width ||
    !sameNumbers(output.tail, existing.tail)
  ) {
    throw new Error(`ranker.${name} batched tensor shape changed.`);
  }
  return existing;
}

function assembleRankerOutputs(
  gathered: ReadonlyMap<string, GatheredRankerOutput>,
  outputNames: readonly string[],
  blockCount: number,
): Readonly<Record<string, FloatTensorLike>> {
  return Object.fromEntries(
    outputNames.map((name) => {
      const value = gathered.get(name);
      if (!value) throw new Error(`ranker.${name} batched output is missing.`);
      return [name, { data: value.data, dims: [blockCount, ...value.tail] }];
    }),
  );
}

async function runRankerBatch(
  model: FontMatchingRuntimeModel,
  features: Float32Array,
  blockCount: number,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, FloatTensorLike>>> {
  const views = model.createFloatTensor(features, [
    blockCount,
    FONT_MATCHING_PIXEL_VIEW_COUNT,
    model.featureDim,
  ]);
  const prototypes = model.createFloatTensor(model.prototypeFeatures, [
    model.prototypeCount,
    model.featureDim,
  ]);
  try {
    return await runSession(
      model.ranker,
      { views, prototype_features: prototypes },
      model.rankerOutputNames,
      signal,
    );
  } finally {
    disposeTensor(views);
    disposeTensor(prototypes);
  }
}

// eslint-disable-next-line max-lines-per-function, complexity -- output heads and opt-in QA guard are validated together
function buildPixelInferenceRows({
  blocks,
  glyphMorphologies,
  candidates,
  model,
  features,
  outputs,
  pageId,
  boundary,
  qaPageRelativeRoleReroute,
}: {
  blocks: readonly FontMatchingPageInferenceBlock[];
  glyphMorphologies: readonly FontMatchingGlyphMorphologyV1[];
  candidates: readonly AutomaticFontCandidate[];
  model: FontMatchingRuntimeModel;
  features: Float32Array;
  outputs: Readonly<Record<string, FloatTensorLike>>;
  pageId: string;
  boundary: FontMatchingInferenceInputBoundary;
  qaPageRelativeRoleReroute: boolean;
}): ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2> {
  const count = blocks.length;
  if (
    features.length !==
      count * FONT_MATCHING_PIXEL_VIEW_COUNT * model.featureDim ||
    glyphMorphologies.length !== count
  ) {
    throw new Error("Font matching encoded feature rows drifted.");
  }
  const compatibilityCandidateScores = requireFloatTensor(
    outputs.candidate_scores,
    [count, candidates.length],
    "ranker.candidate_scores",
  );
  const hybridScores = readHybridCandidateScores(
    outputs,
    model.scoreRouting,
    compatibilityCandidateScores,
    count,
    candidates.length,
  );
  const noneLogits = requireFloatTensor(
    outputs.none_logits,
    [count],
    "ranker.none_logits",
  );
  const roleLogits = requireFloatTensor(
    outputs.role_logits,
    [count, RUNTIME_ROLE_VALUES.length],
    "ranker.role_logits",
  );
  const styleLogits = requireFloatTensor(
    outputs.style_logits,
    [count, RUNTIME_STYLE_FIELDS.length],
    "ranker.style_logits",
  );
  const orientationLogits = requireFloatTensor(
    outputs.treatment_orientation_logits,
    [count, RUNTIME_TREATMENTS.orientation.length],
    "ranker.treatment_orientation_logits",
  );
  const viewGateWeights = requireFloatTensor(
    outputs.view_gate_weights,
    [count, FONT_MATCHING_PIXEL_VIEW_COUNT],
    "ranker.view_gate_weights",
  );
  assertAuxiliaryOutputShapes(outputs, count);
  const pixelRoles = Array.from({ length: count }, (_unused, row) =>
    buildRolePrediction(roleLogits, row),
  );
  const treatments = Array.from({ length: count }, (_unused, row) =>
    buildTreatment(outputs, row),
  );
  const sourceStyles = Array.from({ length: count }, (_unused, row) =>
    buildSourceStyle(styleLogits, row),
  );
  const baselineRows = blocks.map((block, row) => {
    const pixelRole = pixelRoles[row];
    const treatment = treatments[row];
    const sourceStyle = sourceStyles[row];
    if (!pixelRole || !treatment || !sourceStyle) {
      throw new Error("Font matching baseline row inventory drifted.");
    }
    return buildPixelInferenceRow({
      block,
      boundary,
      candidates,
      features,
      glyphMorphology: glyphMorphologies[row],
      model,
      noneLogits,
      orientationLogits,
      pageId,
      plan: undefined,
      roleLogits,
      routed: resolveHybridScoreRoute(
        pixelRole,
        model.scoreRouting,
        hybridScores,
        compatibilityCandidateScores,
      ),
      row,
      sourceStyle,
      styleLogits,
      treatment,
      viewGateWeights,
    });
  });
  if (!qaPageRelativeRoleReroute) {
    return new Map(
      baselineRows.map((inference) => [inference.blockId, inference]),
    );
  }
  const baselinePageConsistencyPlan = buildAutomaticFontPageConsistencyPlan(
    baselineRows,
    buildQaPageConsistencyGeometryItems(blocks, treatments),
  );
  const qaPlan =
    hybridScores && model.scoreRouting
      ? buildPageRelativeQaPlan({
          baselineRows,
          blocks,
          candidateIds: model.candidateIds,
          glyphMorphologies,
          hybridScores,
          model,
          pixelRoles,
          roleLogits,
          treatments,
        })
      : null;
  const result = new Map<string, VerifiedAutomaticFontPixelInferenceV2>();
  for (let row = 0; row < count; row += 1) {
    const block = blocks[row];
    if (!block) throw new Error("Font matching block output row drifted.");
    const baseline = baselineRows[row];
    const pixelRole = pixelRoles[row];
    const treatment = treatments[row];
    const sourceStyle = sourceStyles[row];
    if (!baseline || !pixelRole || !treatment || !sourceStyle) {
      throw new Error("Font matching page-relative row inventory drifted.");
    }
    const shared = {
      block,
      boundary,
      candidates,
      features,
      glyphMorphology: glyphMorphologies[row],
      model,
      noneLogits,
      orientationLogits,
      pageId,
      roleLogits,
      row,
      sourceStyle,
      styleLogits,
      treatment,
      viewGateWeights,
    };
    const plan = qaPlan?.get(block.blockId);
    if (!hybridScores || !model.scoreRouting) {
      result.set(
        block.blockId,
        attachPageRelativeQaAudit(
          baseline,
          pixelRole,
          undefined,
          {
            status: "dual_branch_unavailable",
            reasonCodes: ["qa_page_relative_dual_branch_unavailable"],
            baselinePageConsistencyState:
              baselinePageConsistencyPlan.get(block.blockId) ?? null,
          },
          block.sourceGeometryDirection,
          block.sourceCandidateMembership,
          block.item,
        ),
      );
      continue;
    }
    if (!plan?.applied) {
      result.set(
        block.blockId,
        attachPageRelativeQaAudit(
          baseline,
          pixelRole,
          plan,
          {
            status: "unchanged",
            reasonCodes: plan?.reasonCodes ?? [],
            baselinePageConsistencyState:
              baselinePageConsistencyPlan.get(block.blockId) ?? null,
          },
          block.sourceGeometryDirection,
          block.sourceCandidateMembership,
          block.item,
        ),
      );
      continue;
    }
    const selectionRole = projectFontMatchingPageRelativeRole(pixelRole, plan);
    const qaRoute = resolveHybridScoreRoute(
      selectionRole,
      model.scoreRouting,
      hybridScores,
      compatibilityCandidateScores,
    );
    if (qaRoute.audit?.family !== plan.routeFamily) {
      throw new Error("Page-relative QA route family drifted.");
    }
    const candidate = buildPixelInferenceRow({
      ...shared,
      plan,
      routed: qaRoute,
    });
    const applyGuardTriggered = shouldRevertPageRelativeQaForApplyRate(
      baseline.selectionCalibration.applied,
      candidate.selectionCalibration.applied,
    );
    result.set(
      block.blockId,
      attachPageRelativeQaAudit(
        applyGuardTriggered ? baseline : candidate,
        pixelRole,
        plan,
        {
          status: applyGuardTriggered ? "reverted_apply_rate_guard" : "applied",
          reasonCodes: applyGuardTriggered
            ? [...plan.reasonCodes, "qa_page_relative_apply_rate_guard"]
            : plan.reasonCodes,
          baselinePageConsistencyState:
            baselinePageConsistencyPlan.get(block.blockId) ?? null,
        },
        block.sourceGeometryDirection,
        block.sourceCandidateMembership,
        block.item,
      ),
    );
  }
  return result;
}

function buildQaPageConsistencyGeometryItems(
  blocks: readonly FontMatchingPageInferenceBlock[],
  treatments: readonly FontMatchingTreatmentV2[],
): FontMatchingPageInferenceBlock["item"][] {
  return blocks.map((block, row) => {
    const treatment = treatments[row];
    if (!treatment) {
      throw new Error("Page-relative QA treatment inventory drifted.");
    }
    const sourceDirection = readFontMatchingOcrGeometryDirection(
      block.sourceGeometryDirection,
      block.item,
      block.sourceCandidateMembership,
    );
    return {
      ...block.item,
      direction: sourceDirection?.direction ?? treatment.orientation,
    };
  });
}

function buildPageRelativeQaPlan({
  baselineRows,
  blocks,
  candidateIds,
  glyphMorphologies,
  hybridScores,
  model,
  pixelRoles,
  roleLogits,
  treatments,
}: {
  baselineRows: readonly VerifiedAutomaticFontPixelInferenceV2[];
  blocks: readonly FontMatchingPageInferenceBlock[];
  candidateIds: readonly string[];
  glyphMorphologies: readonly FontMatchingGlyphMorphologyV1[];
  hybridScores: NonNullable<HybridCandidateScores>;
  model: FontMatchingRuntimeModel;
  pixelRoles: readonly FontMatchRolePredictionV2[];
  roleLogits: Float32Array;
  treatments: readonly FontMatchingTreatmentV2[];
}): ReadonlyMap<string, FontMatchingPageRelativeRoleQaPlanRow> {
  const candidateCount = candidateIds.length;
  return buildFontMatchingPageRelativeRoleQaPlan(
    blocks.map((block, row) => {
      const baseline = baselineRows[row];
      const pixelRole = pixelRoles[row];
      const treatment = treatments[row];
      if (!baseline || !pixelRole || !treatment) {
        throw new Error("Page-relative QA input row drifted.");
      }
      return {
        blockId: block.blockId,
        item: {
          id: block.item.id,
          bbox: block.item.bbox,
          candidateIds: block.item.candidateIds,
        },
        pixelRole,
        dialogueProbability: roleLogitProbability(roleLogits, row, "dialogue"),
        emphasisProbability: roleLogitProbability(
          roleLogits,
          row,
          "emphasis_dialogue",
        ),
        glyphMorphology: glyphMorphologies[row],
        sourceGeometryDirection: block.sourceGeometryDirection,
        sourceCandidateMembership: block.sourceCandidateMembership,
        treatment,
        candidateIds,
        bodyScores: hybridScores.body.subarray(
          row * candidateCount,
          (row + 1) * candidateCount,
        ),
        variantScores: hybridScores.variant.subarray(
          row * candidateCount,
          (row + 1) * candidateCount,
        ),
        temperature: model.status.calibration.temperature,
        baselineCalibrationApplied: baseline.selectionCalibration.applied,
        baselineSelectedFontId:
          resolveAutomaticFontCalibratedPixelWinner(baseline)?.fontId ?? null,
      };
    }),
  );
}

function roleLogitProbability(
  logits: Float32Array,
  row: number,
  role: (typeof RUNTIME_ROLE_VALUES)[number],
): number {
  const roleIndex = RUNTIME_ROLE_VALUES.indexOf(role);
  return softmaxRow(logits, row, RUNTIME_ROLE_VALUES.length, 1)[roleIndex] ?? 0;
}

type PixelInferenceRowInput = Readonly<{
  block: FontMatchingPageInferenceBlock;
  boundary: FontMatchingInferenceInputBoundary;
  candidates: readonly AutomaticFontCandidate[];
  features: Float32Array;
  glyphMorphology?: FontMatchingGlyphMorphologyV1;
  model: FontMatchingRuntimeModel;
  noneLogits: Float32Array;
  orientationLogits: Float32Array;
  pageId: string;
  plan?: FontMatchingPageRelativeRoleQaPlanRow;
  roleLogits: Float32Array;
  routed: ReturnType<typeof resolveHybridScoreRoute>;
  row: number;
  sourceStyle: FontMatchingSourceStyleV2;
  styleLogits: Float32Array;
  treatment: FontMatchingTreatmentV2;
  viewGateWeights: Float32Array;
}>;

// eslint-disable-next-line max-lines-per-function -- one row must use one exact score/calibration transaction
function buildPixelInferenceRow({
  block,
  boundary,
  candidates,
  features,
  glyphMorphology,
  model,
  noneLogits,
  orientationLogits,
  pageId,
  plan,
  roleLogits,
  routed,
  row,
  sourceStyle,
  styleLogits,
  treatment,
  viewGateWeights,
}: PixelInferenceRowInput): VerifiedAutomaticFontPixelInferenceV2 {
  const scoreOffset = row * candidates.length;
  const eligibility = resolvePixelCandidateEligibility(
    model.candidateIds,
    routed.scores.subarray(scoreOffset, scoreOffset + candidates.length),
    routed.selectionRole,
  );
  const candidateScores = applyFontMatchingPageRelativePeerScorePreference(
    model.candidateIds,
    eligibility.scores,
    eligibility.eligibleMask,
    plan,
  );
  const probabilities = softmaxRow(
    candidateScores,
    0,
    candidates.length,
    model.status.calibration.temperature,
  );
  const rawRankedCandidates = markRetiredAutomaticFontCandidates(
    buildRankedCandidates(
      candidates,
      probabilities,
      sourceStyle,
      routed.selectionRole,
      treatment,
    ),
  );
  const noneProbability = sigmoid(noneLogits[row] ?? 0);
  const noneAcceptable =
    noneProbability >= model.status.calibration.noneThreshold;
  const featureSet = buildFontMatchingSelectionFeatureSet(
    {
      candidateIds: model.candidateIds,
      candidateScores,
      runtimeTemperature: model.status.calibration.temperature,
      noneLogit: noneLogits[row] ?? 0,
      roleLogits: roleLogits.subarray(
        row * RUNTIME_ROLE_VALUES.length,
        (row + 1) * RUNTIME_ROLE_VALUES.length,
      ),
      styleLogits: styleLogits.subarray(
        row * RUNTIME_STYLE_FIELDS.length,
        (row + 1) * RUNTIME_STYLE_FIELDS.length,
      ),
      orientationLogits: orientationLogits.subarray(
        row * RUNTIME_TREATMENTS.orientation.length,
        (row + 1) * RUNTIME_TREATMENTS.orientation.length,
      ),
      viewGateWeights: viewGateWeights.subarray(
        row * FONT_MATCHING_PIXEL_VIEW_COUNT,
        (row + 1) * FONT_MATCHING_PIXEL_VIEW_COUNT,
      ),
      viewFeatures: selectFeaturePrefixRows(
        features.subarray(
          row * FONT_MATCHING_PIXEL_VIEW_COUNT * model.featureDim,
          (row + 1) * FONT_MATCHING_PIXEL_VIEW_COUNT * model.featureDim,
        ),
        FONT_MATCHING_PIXEL_VIEW_COUNT,
        model.featureDim,
        model.selectionFeatureDim,
      ),
      featureDim: model.selectionFeatureDim,
      prototypeFeatures: model.selectionPrototypeFeatures,
      prototypeBags: model.prototypeBags,
    },
    model.selectionCalibration,
  );
  const selection = applySupervisedFontSelectionCalibration({
    rankedCandidates: rawRankedCandidates,
    role: routed.selectionRole.primary,
    calibration: model.selectionCalibration,
    featureSet,
    noneAcceptable,
    allowFailedReleaseQuality:
      model.qaOnlyRuntime || Boolean(model.failedCalibrationQualityAccepted),
  });
  const rankedCandidates = selection.rankedCandidates;
  return {
    kind: "verified_pixel_inference",
    pageId,
    blockId: block.blockId,
    modelVersion: model.status.modelVersion,
    candidateOrderSha256: model.status.candidateOrderSha256,
    inputBoundary: boundary,
    rolePrediction: routed.selectionRole,
    ...(routed.audit ? { scoreRoute: routed.audit } : {}),
    sourceStyle,
    treatment,
    selectionCalibration: {
      applied: selection.calibrationApplied,
      fallbackReason: selection.fallbackReason,
      operatingFamily: selection.operatingFamily,
      selectionScore: selection.selectionScore,
      globalRiskLowerConfidenceBound:
        model.selectionCalibration.operatingPoints.global.risk_lcb,
    },
    glyphMorphology,
    localEvidence: {
      rankedCandidates,
      calibratedConfidence: rankedCandidates[0]?.confidence ?? 0,
      noneAcceptable,
      catalogVersion: model.status.catalogVersion,
      modelVersion: model.status.modelVersion,
      rendererHash: model.rendererHash,
    },
  };
}

function attachPageRelativeQaAudit(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  pixelRole: FontMatchRolePredictionV2,
  plan: FontMatchingPageRelativeRoleQaPlanRow | undefined,
  outcome: Readonly<{
    status: NonNullable<
      VerifiedAutomaticFontPixelInferenceV2["pageRelativeRoleQa"]
    >["status"];
    reasonCodes: readonly string[];
    baselinePageConsistencyState: NonNullable<
      VerifiedAutomaticFontPixelInferenceV2["pageRelativeRoleQa"]
    >["baselinePageConsistencyState"];
  }>,
  sourceGeometryDirection: unknown,
  sourceCandidateMembership: unknown,
  item: FontMatchingPageInferenceBlock["item"],
): VerifiedAutomaticFontPixelInferenceV2 {
  return {
    ...inference,
    pageRelativeRoleQa: {
      policyVersion: FONT_MATCHING_PAGE_RELATIVE_ROLE_QA_POLICY.version,
      status: outcome.status,
      originalRole: pixelRole.primary,
      ...resolvePageRelativeQaAuditRoleFields(pixelRole, plan),
      ...resolvePageRelativeQaAuditClusterFields(
        plan,
        sourceGeometryDirection,
        sourceCandidateMembership,
        item,
      ),
      baselinePageConsistencyState: cloneBaselinePageConsistencyState(
        outcome.baselinePageConsistencyState,
      ),
      reasonCodes: [...outcome.reasonCodes],
      confidencePolicy: "preserve_original_pixel_primary_confidence",
      applyRateGuard: "selection_calibration_non_decreasing",
    },
  };
}

function resolvePageRelativeQaAuditRoleFields(
  pixelRole: FontMatchRolePredictionV2,
  plan: FontMatchingPageRelativeRoleQaPlanRow | undefined,
): Pick<
  NonNullable<VerifiedAutomaticFontPixelInferenceV2["pageRelativeRoleQa"]>,
  "projectedRole" | "routeFamily"
> {
  return {
    projectedRole: plan?.projectedRole ?? pixelRole.primary,
    routeFamily:
      plan?.routeFamily ?? resolvePageRelativeQaRouteFamily(pixelRole),
  };
}

function resolvePageRelativeQaAuditClusterFields(
  plan: FontMatchingPageRelativeRoleQaPlanRow | undefined,
  sourceGeometryDirection: unknown,
  sourceCandidateMembership: unknown,
  item: FontMatchingPageInferenceBlock["item"],
): Pick<
  NonNullable<VerifiedAutomaticFontPixelInferenceV2["pageRelativeRoleQa"]>,
  | "clusterId"
  | "clusterBodyAnchorFontId"
  | "sourceGeometryDirection"
  | "preferredPeerFontId"
  | "peerBlockId"
> {
  return {
    sourceGeometryDirection:
      plan?.sourceGeometryDirection ??
      readFontMatchingOcrGeometryDirection(
        sourceGeometryDirection,
        item,
        sourceCandidateMembership,
      ),
    clusterId: plan?.clusterId ?? null,
    clusterBodyAnchorFontId: plan?.clusterBodyAnchorFontId ?? null,
    preferredPeerFontId: plan?.preferredPeerFontId ?? null,
    peerBlockId: plan?.peerBlockId ?? null,
  };
}

function resolvePageRelativeQaRouteFamily(
  pixelRole: FontMatchRolePredictionV2,
): "body" | "variant" {
  return BODY_ROLES_FOR_QA_AUDIT.has(pixelRole.primary) ? "body" : "variant";
}

function cloneBaselinePageConsistencyState(
  state: NonNullable<
    VerifiedAutomaticFontPixelInferenceV2["pageRelativeRoleQa"]
  >["baselinePageConsistencyState"],
): NonNullable<
  VerifiedAutomaticFontPixelInferenceV2["pageRelativeRoleQa"]
>["baselinePageConsistencyState"] {
  return state ? { ...state } : null;
}

const BODY_ROLES_FOR_QA_AUDIT = new Set<FontMatchingSemanticRole>([
  "dialogue",
  "narration",
  "thought",
]);

type HybridCandidateScores = Readonly<{
  body: Float32Array;
  variant: Float32Array;
}> | null;

function readHybridCandidateScores(
  outputs: Readonly<Record<string, FloatTensorLike>>,
  routing: HybridScoreRouting | null,
  compatibility: Float32Array,
  count: number,
  candidateCount: number,
): HybridCandidateScores {
  if (!routing) return null;
  const body = requireFloatTensor(
    outputs[routing.bodyOutput],
    [count, candidateCount],
    `ranker.${routing.bodyOutput}`,
  );
  const variant = requireFloatTensor(
    outputs[routing.variantOutput],
    [count, candidateCount],
    `ranker.${routing.variantOutput}`,
  );
  if (
    body.length !== compatibility.length ||
    body.some((value, index) => value !== compatibility[index])
  ) {
    throw new Error(
      "Hybrid ranker candidate_scores compatibility alias drifted.",
    );
  }
  return { body, variant };
}

function resolveHybridScoreRoute(
  pixelRole: FontMatchRolePredictionV2,
  routing: HybridScoreRouting | null,
  hybridScores: HybridCandidateScores,
  compatibilityScores: Float32Array,
): Readonly<{
  scores: Float32Array;
  selectionRole: FontMatchRolePredictionV2;
  audit: VerifiedAutomaticFontPixelInferenceV2["scoreRoute"] | null;
}> {
  if (!routing || !hybridScores) {
    return {
      scores: compatibilityScores,
      selectionRole: pixelRole,
      audit: null,
    };
  }
  // Keep head routing strictly downstream of original-page pixels. OCR/LLM
  // item.fontRole and item.textRole must never alter scores or selection.
  const selectionRole = pixelRole;
  const body = routing.bodyRoles.has(selectionRole.primary);
  return {
    scores: body ? hybridScores.body : hybridScores.variant,
    selectionRole,
    audit: {
      family: body ? "body" : "variant",
      outputName: body ? routing.bodyOutput : routing.variantOutput,
      resolvedRole: selectionRole.primary,
    },
  };
}

function selectFeaturePrefixRows(
  values: Float32Array,
  rowCount: number,
  rowWidth: number,
  prefixWidth: number,
): Float32Array {
  if (
    rowCount < 1 ||
    rowWidth < 1 ||
    prefixWidth < 1 ||
    prefixWidth > rowWidth ||
    values.length !== rowCount * rowWidth
  ) {
    throw new Error("Font matching selection feature prefix is invalid.");
  }
  if (prefixWidth === rowWidth) return values;
  const selected = new Float32Array(rowCount * prefixWidth);
  for (let row = 0; row < rowCount; row += 1) {
    selected.set(
      values.subarray(row * rowWidth, row * rowWidth + prefixWidth),
      row * prefixWidth,
    );
  }
  return selected;
}

function buildRankedCandidates(
  candidates: readonly AutomaticFontCandidate[],
  probabilities: readonly number[],
  style: FontMatchingSourceStyleV2,
  role: FontMatchRolePredictionV2,
  treatment: FontMatchingTreatmentV2,
): RankedFontCandidateV2[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      candidateIndex: index,
      probability: probabilities[index] ?? 0,
      styleFit: candidateStyleFit(candidate, style),
    }))
    .sort(
      (left, right) =>
        right.probability - left.probability ||
        left.candidateIndex - right.candidateIndex,
    )
    .map(({ candidate, probability, styleFit }, index) => ({
      rank: index + 1,
      rawPixelRank: index + 1,
      rawPixelScore: probability,
      fontId: candidate.fontId,
      renderStatus: "rendered",
      unrenderableReason: null,
      styleFit,
      roleFit: role.confidence,
      layoutFit: null,
      glyphCoverage: null,
      workProfileFit: 0,
      userPreferenceFit: 0,
      genrePriorContribution: 0,
      switchPenalty: 0,
      totalScore: probability,
      confidence: probability,
      reasonCodes: [
        "verified_pixel_model",
        "source_style_head",
        `treatment_orientation_${treatment.orientation}`,
      ],
    }));
}

function candidateStyleFit(
  candidate: AutomaticFontCandidate,
  style: FontMatchingSourceStyleV2,
): number {
  const candidateWeight = clampProbability((candidate.weight - 100) / 800);
  const candidateWidth = clampProbability((candidate.width - 1) / 8);
  const dimensions = [
    1 - Math.abs((style.serifness ?? 0.5) - (candidate.serif ? 1 : 0)),
    1 - Math.abs((style.weight ?? 0.5) - candidateWeight),
    1 - Math.abs((style.width ?? 0.5) - candidateWidth),
    1 - Math.abs((style.slant ?? 0.5) - (candidate.italic ? 1 : 0)),
  ];
  return dimensions.reduce((sum, value) => sum + value, 0) / dimensions.length;
}

function buildRolePrediction(
  logits: Float32Array,
  row: number,
): FontMatchRolePredictionV2 {
  const probabilities = softmaxRow(logits, row, RUNTIME_ROLE_VALUES.length, 1);
  const ordering = probabilities
    .map((confidence, index) => ({ confidence, index }))
    .sort(
      (left, right) =>
        right.confidence - left.confidence || left.index - right.index,
    );
  const primary = ordering[0];
  if (!primary) {
    return { primary: "unknown_needs_review", confidence: 0, alternatives: [] };
  }
  return {
    primary: RUNTIME_ROLE_VALUES[primary.index] ?? "unknown_needs_review",
    confidence: primary.confidence,
    alternatives: ordering.slice(1, 3).map((entry) => ({
      role: RUNTIME_ROLE_VALUES[entry.index] ?? "unknown_needs_review",
      confidence: entry.confidence,
    })),
  };
}

function buildSourceStyle(
  logits: Float32Array,
  row: number,
): FontMatchingSourceStyleV2 {
  const offset = row * RUNTIME_STYLE_FIELDS.length;
  const values = RUNTIME_STYLE_FIELDS.map((_, index) =>
    sigmoid(logits[offset + index] ?? 0),
  );
  return {
    serifness: values[0] ?? null,
    weight: values[1] ?? null,
    width: values[2] ?? null,
    roundness: values[3] ?? null,
    strokeContrast: values[4] ?? null,
    handwritten: values[5] ?? null,
    angularity: values[6] ?? null,
    irregularity: values[7] ?? null,
    slant: values[8] ?? null,
    energy: values[9] ?? null,
    unknownFields: [],
  };
}

// eslint-disable-next-line complexity -- exhaustive treatment vocabulary mapping is fail-closed
function buildTreatment(
  outputs: Readonly<Record<string, FloatTensorLike>>,
  row: number,
): FontMatchingTreatmentV2 {
  const distortion = treatmentValue(outputs, "distortion", row);
  const fill = treatmentValue(outputs, "fill", row);
  const orientation = treatmentValue(outputs, "orientation", row);
  const outline = treatmentValue(outputs, "outline", row);
  const shadow = treatmentValue(outputs, "shadow", row);
  return {
    orientation: orientation === "vertical" ? "vertical" : "horizontal",
    outline:
      outline === "single"
        ? "single"
        : outline === "double" || outline === "multiple"
          ? "multiple"
          : outline === "none"
            ? "none"
            : "unknown",
    shadow:
      shadow === "hard" || shadow === "soft" || shadow === "none"
        ? shadow
        : "unknown",
    fill:
      fill === "solid" || fill === "gradient" || fill === "pattern"
        ? fill
        : "unknown",
    distortion:
      distortion === "none" || distortion === "perspective"
        ? distortion
        : ["slant", "warp", "wave", "jitter"].includes(distortion)
          ? "warped"
          : "unknown",
    polarity: fill === "inverse" ? "inverse" : "unknown",
    colorMode: "unknown",
  };
}

function treatmentValue(
  outputs: Readonly<Record<string, FloatTensorLike>>,
  field: keyof typeof RUNTIME_TREATMENTS,
  row: number,
): string {
  const values = RUNTIME_TREATMENTS[field];
  const tensor = requireFloatTensor(
    outputs[`treatment_${field}_logits`],
    [-1, values.length],
    `ranker.treatment_${field}_logits`,
  );
  const offset = row * values.length;
  let selected = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (
      (tensor[offset + index] ?? -Infinity) >
      (tensor[offset + selected] ?? -Infinity)
    ) {
      selected = index;
    }
  }
  return values[selected] ?? "unknown";
}

function assertAuxiliaryOutputShapes(
  outputs: Readonly<Record<string, FloatTensorLike>>,
  count: number,
): void {
  for (const [field, values] of Object.entries(RUNTIME_TREATMENTS)) {
    requireFloatTensor(
      outputs[`treatment_${field}_logits`],
      [count, values.length],
      `ranker.treatment_${field}_logits`,
    );
  }
  requireFloatTensor(
    outputs.view_gate_weights,
    [count, FONT_MATCHING_PIXEL_VIEW_COUNT],
    "ranker.view_gate_weights",
  );
}

// eslint-disable-next-line complexity -- every sealed runtime section is a mandatory conjunct
function parseRuntimeInferenceContract(
  value: Record<string, unknown>,
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>,
  rendererHash: string,
  prototypeByteLength: number,
): RuntimeContract | null {
  const catalog = recordAt(value, "catalog");
  const head = recordAt(value, "head");
  const architecture = head ? recordAt(head, "architecture") : null;
  const schemaVersion = value.schema_version;
  const runtimeBatching = parseRuntimeBatching(
    schemaVersion,
    value.runtime_batching,
  );
  const featureDim = positiveInteger(architecture?.feature_dim);
  const scoreRouting = parseHybridScoreRouting(
    schemaVersion,
    value.hybrid_score_routing,
    architecture,
  );
  const selectionFeatureDim = scoreRouting?.selectionFeatureDim ?? featureDim;
  const prototypeCount = positiveInteger(catalog?.prototype_count);
  const preprocessing = recordAt(value, "preprocessing");
  const encoder = recordAt(value, "encoder");
  const prototypeBags = parsePrototypeBags(
    catalog?.prototype_bags,
    status.candidateIds,
    prototypeCount ?? 0,
  );
  const catalogRegistrySha256 = sha256OrNull(catalog?.catalog_registry_sha256);
  if (
    (schemaVersion !== FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA &&
      schemaVersion !== FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2) ||
    (schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA &&
      value.hybrid_score_routing !== undefined) ||
    (schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2 &&
      !scoreRouting) ||
    !runtimeBatching ||
    !featureDim ||
    !selectionFeatureDim ||
    !prototypeCount ||
    prototypeByteLength !== featureDim * prototypeCount * 4 ||
    !validPreprocessing(preprocessing) ||
    !validEncoder(encoder, schemaVersion) ||
    !prototypeBags ||
    !catalogRegistrySha256 ||
    !validOnnxIoContract(
      value.onnx_io_contract,
      featureDim,
      prototypeCount,
      status.candidateIds.length,
      scoreRouting,
    ) ||
    !/^[a-f0-9]{64}$/u.test(rendererHash)
  ) {
    return null;
  }
  return {
    featureDim,
    encoderBatchSize: runtimeBatching.encoderBatchSize,
    selectionFeatureDim,
    prototypeCount,
    prototypeBags,
    catalogRegistrySha256,
    rendererHash,
    rankerOutputNames: scoreRouting
      ? HYBRID_RANKER_OUTPUT_NAMES
      : LEGACY_RANKER_OUTPUT_NAMES,
    rankerBatchSize: runtimeBatching.rankerBatchSize,
    scoreRouting,
  };
}

function parseRuntimeBatching(
  schemaVersion: unknown,
  value: unknown,
): { encoderBatchSize: number; rankerBatchSize: number } | null {
  if (schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA) {
    return value === undefined
      ? {
          encoderBatchSize: LEGACY_ENCODER_BATCH_SIZE,
          rankerBatchSize: LEGACY_RANKER_BATCH_SIZE,
        }
      : null;
  }
  if (
    schemaVersion !== FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2 ||
    !isRecord(value) ||
    value.encoder_batch_size !== 2 ||
    value.ranker_batch_size !== 16 ||
    value.parity_qualified !== true ||
    Object.keys(value).length !== 3
  ) {
    return null;
  }
  return { encoderBatchSize: 2, rankerBatchSize: 16 };
}

// eslint-disable-next-line complexity -- exact preprocessing fields deliberately fail as one gate
function validPreprocessing(value: Record<string, unknown> | null): boolean {
  const processor = value ? recordAt(value, "processor") : null;
  const recipe = value ? recordAt(value, "prototype_to_encoder_input") : null;
  return Boolean(
    value?.input_mode === "RGB" &&
    sameNumbers(value.input_size_px, [224, 224]) &&
    value.sample_views === "verified-rgb-224-passthrough-v1" &&
    processor?.class === "AutoImageProcessor" &&
    processor.do_resize === false &&
    processor.use_fast === false &&
    recipe?.algorithm === "fontclip-letterbox-rgb-v1" &&
    recipe.operation === "aspect_preserving_letterbox" &&
    recipe.resize_filter === "lanczos" &&
    recipe.placement === "center_floor" &&
    sameNumbers(recipe.target_size_px, [224, 224]) &&
    sameNumbers(recipe.canvas_color_rgb, [255, 255, 255]),
  );
}

function parseHybridScoreRouting(
  schemaVersion: unknown,
  value: unknown,
  architecture: Record<string, unknown> | null,
): HybridScoreRouting | null {
  if (schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA) {
    return value === undefined ? null : invalidHybridRouting();
  }
  if (
    schemaVersion !== FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2 ||
    !isRecord(value)
  ) {
    return invalidHybridRouting();
  }
  const bodyRoles = stringArray(value.body_roles);
  const variantRoles = stringArray(value.variant_roles);
  const expectedVariantRoles = RUNTIME_ROLE_VALUES.filter(
    (role) => !["dialogue", "narration", "thought"].includes(role),
  );
  const selectionFeatureDim = positiveInteger(value.selection_feature_dim);
  if (
    !validHybridRoutingRecord(
      value,
      bodyRoles,
      variantRoles,
      expectedVariantRoles,
    )
  ) {
    return invalidHybridRouting();
  }
  if (!validHybridRoutingArchitecture(architecture, selectionFeatureDim)) {
    return invalidHybridRouting();
  }
  return {
    bodyRoles: new Set(bodyRoles as FontMatchingSemanticRole[]),
    bodyOutput: "body_candidate_scores",
    variantOutput: "variant_candidate_scores",
    selectionFeatureDim,
  };
}

function validHybridRoutingRecord(
  value: Record<string, unknown>,
  bodyRoles: readonly string[] | null,
  variantRoles: readonly string[] | null,
  expectedVariantRoles: readonly string[],
): boolean {
  return [
    value.schema_version === "font-matching-hybrid-score-routing-v1",
    value.candidate_scores_compatibility_alias === "body_candidate_scores",
    value.body_candidate_output === "body_candidate_scores",
    value.variant_candidate_output === "variant_candidate_scores",
    sameStrings(bodyRoles ?? [], ["dialogue", "narration", "thought"]),
    sameStrings(variantRoles ?? [], expectedVariantRoles),
    value.unknown_role_fallback === "variant_candidate_scores",
    value.role_source ===
      "resolveCombinedAutomaticFontRole(item.fontRole,pixelRole)",
    value.selection_feature_source ===
      "selected_candidate_scores_with_legacy256_visual_features",
    value.selection_feature_dim === 256,
    value.row_specific_rules === false,
  ].every(Boolean);
}

function validHybridRoutingArchitecture(
  architecture: Record<string, unknown> | null,
  selectionFeatureDim: number | null,
): selectionFeatureDim is number {
  return [
    selectionFeatureDim === 256,
    architecture?.legacy_feature_dim === selectionFeatureDim,
    architecture?.variant_feature_dim === 1024,
    architecture?.variant_query_count === 4,
    architecture?.variant_query_dim === 256,
  ].every(Boolean);
}

function invalidHybridRouting(): null {
  return null;
}

function validEncoder(
  value: Record<string, unknown> | null,
  schemaVersion: unknown,
): boolean {
  if (!value) return false;
  const versionValid =
    schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA
      ? value.class === "SiglipVisionModel" &&
        value.version === "siglip-vision-onnx-v1"
      : schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2
        ? value.class === "DualSiglipVisionModel" &&
          value.version ===
            "dual-siglip-vision-body-pooler-variant-patch-query-onnx-v1" &&
          validDualEncoderBranches(recordAt(value, "branches"))
        : false;
  return Boolean(
    versionValid &&
    value.fully_frozen === true &&
    value.model_id === "google/siglip2-base-patch16-224" &&
    typeof value.revision === "string" &&
    /^[a-f0-9]{40}$/u.test(value.revision),
  );
}

function validDualEncoderBranches(
  value: Record<string, unknown> | null,
): boolean {
  return Boolean(
    value?.body === "v2_finetuned_pooler_projection256" &&
    value.variant === "pinned_base_patch_tokens_four_query_embeddings1024" &&
    value.shared_weights_assumed === false,
  );
}

function parsePrototypeBags(
  value: unknown,
  candidateIds: readonly string[],
  prototypeCount: number,
): readonly FontMatchingPrototypeBag[] | null {
  if (!Array.isArray(value) || value.length !== candidateIds.length)
    return null;
  let nextStart = 0;
  const bags: FontMatchingPrototypeBag[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) return null;
    const count = positiveInteger(raw.count);
    if (
      raw.candidate_id !== candidateIds[index] ||
      raw.start !== nextStart ||
      !count
    ) {
      return null;
    }
    bags.push({ candidateId: raw.candidate_id, start: nextStart, count });
    nextStart += count;
  }
  return nextStart === prototypeCount ? bags : null;
}

function validOnnxIoContract(
  value: unknown,
  featureDim: number,
  prototypeCount: number,
  candidateCount: number,
  scoreRouting: HybridScoreRouting | null,
): boolean {
  if (!isRecord(value)) return false;
  const encoder = recordAt(value, ENCODER_FILE);
  const ranker = recordAt(value, RANKER_FILE);
  return Boolean(
    validIoEntries(encoder?.inputs, [["pixel_values", [null, 3, 224, 224]]]) &&
    validIoEntries(encoder?.outputs, [
      ["image_features", [null, featureDim]],
    ]) &&
    validIoEntries(ranker?.inputs, [
      ["views", [null, 3, featureDim]],
      ["prototype_features", [prototypeCount, featureDim]],
    ]) &&
    validIoEntries(
      ranker?.outputs,
      scoreRouting
        ? [
            ["candidate_scores", [null, candidateCount]],
            ["body_candidate_scores", [null, candidateCount]],
            ["variant_candidate_scores", [null, candidateCount]],
            ["none_logits", [null]],
            ["role_logits", [null, RUNTIME_ROLE_VALUES.length]],
            ["style_logits", [null, RUNTIME_STYLE_FIELDS.length]],
            ...Object.entries(RUNTIME_TREATMENTS).map(
              ([field, values]) =>
                [`treatment_${field}_logits`, [null, values.length]] as const,
            ),
            ["view_gate_weights", [null, FONT_MATCHING_PIXEL_VIEW_COUNT]],
          ]
        : [
            ["candidate_scores", [null, candidateCount]],
            ["none_logits", [null]],
            ["role_logits", [null, RUNTIME_ROLE_VALUES.length]],
            ["style_logits", [null, RUNTIME_STYLE_FIELDS.length]],
            ...Object.entries(RUNTIME_TREATMENTS).map(
              ([field, values]) =>
                [`treatment_${field}_logits`, [null, values.length]] as const,
            ),
            ["view_gate_weights", [null, FONT_MATCHING_PIXEL_VIEW_COUNT]],
          ],
    ),
  );
}

function validIoEntries(
  value: unknown,
  expected: readonly (readonly [string, readonly (number | null)[]])[],
): boolean {
  return Boolean(
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((raw, index) => {
      const target = expected[index];
      return Boolean(
        isRecord(raw) &&
        target &&
        raw.name === target[0] &&
        raw.type === "tensor(float)" &&
        sameNullableNumbers(raw.shape, target[1]),
      );
    }),
  );
}

function readPrototypeFeatures(
  bytes: Uint8Array,
  contract: RuntimeContract,
  sha256: string,
): Float32Array {
  const cached = prototypeCache.get(sha256);
  if (cached) return cached;
  const count = contract.featureDim * contract.prototypeCount;
  const values = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) {
      throw new Error("Prototype feature bank contains a non-finite value.");
    }
    values[index] = value;
  }
  prototypeCache.set(sha256, values);
  return values;
}

async function getOrCreateSessions({
  encoderBytes,
  encoderSha256,
  rankerBytes,
  rankerSha256,
  wasmAssets,
}: {
  encoderBytes: Uint8Array;
  encoderSha256: string;
  rankerBytes: Uint8Array;
  rankerSha256: string;
  wasmAssets: OrtWasmAssets;
}): Promise<
  Readonly<{
    encoder: FontMatchingOnnxSession;
    ranker: FontMatchingOnnxSession;
  }>
> {
  configureWasmRuntime(wasmAssets);
  const key = JSON.stringify([
    encoderSha256,
    rankerSha256,
    resolve(wasmAssets.wasmBinaryPath),
    resolve(wasmAssets.wasmModulePath),
  ]);
  let pending = sessionCache.get(key);
  if (!pending) {
    pending = Promise.all([
      ort.InferenceSession.create(encoderBytes, sessionOptions()),
      ort.InferenceSession.create(rankerBytes, sessionOptions()),
    ])
      .then(([encoder, ranker]) => ({
        encoder: encoder as FontMatchingOnnxSession,
        ranker: ranker as FontMatchingOnnxSession,
      }))
      .catch((error: unknown) => {
        if (sessionCache.get(key) === pending) sessionCache.delete(key);
        throw error;
      });
    sessionCache.set(key, pending);
  }
  return pending;
}

function sessionOptions(): ort.InferenceSession.SessionOptions {
  return {
    executionProviders: ["wasm"],
    executionMode: "sequential",
    graphOptimizationLevel: "all",
  };
}

function configureWasmRuntime(paths: OrtWasmAssets): void {
  const resolved = {
    wasmBinaryPath: resolve(paths.wasmBinaryPath),
    wasmModulePath: resolve(paths.wasmModulePath),
  };
  if (
    configuredWasmPaths &&
    (configuredWasmPaths.wasmBinaryPath !== resolved.wasmBinaryPath ||
      configuredWasmPaths.wasmModulePath !== resolved.wasmModulePath)
  ) {
    throw new Error(
      "Font matching ONNX WASM paths changed after initialization.",
    );
  }
  ort.env.wasm.wasmPaths = {
    mjs: pathToFileURL(resolved.wasmModulePath).href,
    wasm: pathToFileURL(resolved.wasmBinaryPath).href,
  };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  configuredWasmPaths = resolved;
}

export async function resolveFontMatchingOrtWasmAssets(
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">,
): Promise<OrtWasmAssets> {
  const runtimeRoot = join(
    paths.runtimeDir,
    "onnxruntime-web",
    ONNXRUNTIME_WEB_VERSION,
  );
  const dataRoot = join(
    paths.dataRoot,
    "runtime",
    "onnxruntime-web",
    ONNXRUNTIME_WEB_VERSION,
  );
  const modulePath = await firstVerifiedAsset(
    [
      join(runtimeRoot, ONNXRUNTIME_WEB_WASM_MODULE_FILE),
      safeRequireResolve(`onnxruntime-web/${ONNXRUNTIME_WEB_WASM_MODULE_FILE}`),
    ],
    ONNXRUNTIME_WEB_WASM_MODULE_BYTES,
    ONNXRUNTIME_WEB_WASM_MODULE_SHA256,
  );
  const binaryPath = await firstVerifiedAsset(
    [
      join(runtimeRoot, ONNXRUNTIME_WEB_WASM_BINARY_FILE),
      join(dataRoot, ONNXRUNTIME_WEB_WASM_BINARY_FILE),
      safeRequireResolve(`onnxruntime-web/${ONNXRUNTIME_WEB_WASM_BINARY_FILE}`),
    ],
    ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
    ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  );
  if (!modulePath || !binaryPath) {
    throw new Error("Verified onnxruntime-web WASM assets are unavailable.");
  }
  return { wasmModulePath: modulePath, wasmBinaryPath: binaryPath };
}

async function firstVerifiedAsset(
  candidates: readonly (string | null)[],
  expectedBytes: number,
  expectedSha256: string,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const [stat, bytes] = await Promise.all([
        lstat(candidate),
        readFile(candidate),
      ]);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === expectedBytes &&
        createHash("sha256").update(bytes).digest("hex") === expectedSha256
      ) {
        return resolve(candidate);
      }
    } catch (_error) {
      // error-policy-allow: optional candidate locations are tried in a sealed order.
    }
  }
  return null;
}

function safeRequireResolve(specifier: string): string | null {
  try {
    return require.resolve(specifier);
  } catch (_error) {
    return null;
  }
}

async function runSession(
  session: FontMatchingOnnxSession,
  feeds: Readonly<Record<string, unknown>>,
  fetches: readonly string[],
  signal?: AbortSignal,
): Promise<Readonly<Record<string, FloatTensorLike>>> {
  throwIfAborted(signal);
  const options = { terminate: false };
  const terminate = (): void => {
    options.terminate = true;
  };
  signal?.addEventListener("abort", terminate, { once: true });
  try {
    const outputs = await session.run(feeds, fetches, options);
    throwIfAborted(signal);
    return outputs;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  } finally {
    signal?.removeEventListener("abort", terminate);
  }
}

function requireFloatTensor(
  value: FloatTensorLike | undefined,
  expectedShape: readonly number[],
  location: string,
): Float32Array {
  if (!value || !(value.data instanceof Float32Array)) {
    throw new Error(`${location} is not a float32 tensor.`);
  }
  if (
    value.dims.length !== expectedShape.length ||
    !value.dims.every(
      (dimension, index) =>
        expectedShape[index] === -1 || dimension === expectedShape[index],
    )
  ) {
    throw new Error(`${location} shape drifted.`);
  }
  if (value.data.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`${location} contains a non-finite value.`);
  }
  return value.data;
}

function assertSessionNames(
  session: FontMatchingOnnxSession,
  expectedInputs: readonly string[],
  expectedOutputs: readonly string[],
): void {
  if (
    !sameStrings(session.inputNames, expectedInputs) ||
    !sameStrings(session.outputNames, expectedOutputs)
  ) {
    throw new Error("Font matching ONNX session I/O names drifted.");
  }
}

function assertInferenceCatalog(
  model: FontMatchingRuntimeModel,
  candidates: readonly AutomaticFontCandidate[],
): void {
  if (
    !sameStrings(
      candidates.map(({ fontId }) => fontId),
      model.candidateIds,
    )
  ) {
    throw new Error("Font matching runtime candidate order drifted.");
  }
}

export function sameCandidateSnapshot(
  left: readonly AutomaticFontCandidate[],
  right: readonly AutomaticFontCandidate[],
): boolean {
  return (
    sameStrings(
      left.map(({ fontId }) => fontId),
      right.map(({ fontId }) => fontId),
    ) &&
    resolveFontMatchingV2CatalogVersion(left) ===
      resolveFontMatchingV2CatalogVersion(right)
  );
}

export function assertUserPageBoundary(
  boundary: FontMatchingInferenceInputBoundary,
): void {
  if (
    boundary.source !== "user_page" ||
    boundary.datasetSplit !== null ||
    boundary.qaOverlay !== false
  ) {
    throw new Error(
      "Training/test split or QA-overlay pixels are forbidden at runtime.",
    );
  }
}

function softmaxRow(
  values: Float32Array,
  row: number,
  width: number,
  temperature: number,
): number[] {
  const offset = row * width;
  let maximum = -Infinity;
  for (let index = 0; index < width; index += 1) {
    maximum = Math.max(maximum, (values[offset + index] ?? 0) / temperature);
  }
  const output = Array.from({ length: width }, (_, index) =>
    Math.exp((values[offset + index] ?? 0) / temperature - maximum),
  );
  const total = output.reduce((sum, value) => sum + value, 0);
  return output.map((value) => clampProbability(value / total));
}

function sigmoid(value: number): number {
  return clampProbability(1 / (1 + Math.exp(-value)));
}

function disposeOutputs(
  outputs: Readonly<Record<string, FloatTensorLike>>,
): void {
  for (const output of Object.values(outputs)) disposeTensor(output);
}

function disposeTensor(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "dispose" in value &&
    typeof value.dispose === "function"
  ) {
    value.dispose();
  }
}

function requiredBytes(
  assets: Readonly<Record<string, Uint8Array>>,
  file: string,
): Uint8Array {
  const value = assets[file];
  if (!value?.byteLength) throw new Error(`Runtime asset is empty: ${file}`);
  return value;
}

export function emptyResult(
  status?: FontMatchingRuntimeArtifactStatus,
): FontMatchingPageInferenceResult {
  return {
    ...(status ? { runtimeArtifactStatus: status } : {}),
    pixelInferenceByBlockId: new Map(),
  };
}

export function disabled(
  reason: Extract<
    FontMatchingRuntimeArtifactStatus,
    { state: "disabled" }
  >["reason"],
): Extract<FontMatchingRuntimeArtifactStatus, { state: "disabled" }> {
  return {
    state: "disabled",
    automaticMutationAllowed: false,
    semanticBootstrapAllowed: false,
    reason,
  };
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameNumbers(value: unknown, expected: readonly number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function sameNullableNumbers(
  value: unknown,
  expected: readonly (number | null)[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
    ? [...value]
    : null;
}

function sha256OrNull(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    ? value
    : null;
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const selected = value[key];
  return isRecord(selected) ? selected : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampProbability(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
