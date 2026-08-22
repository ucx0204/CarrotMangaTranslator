/* eslint-disable complexity, max-depth, max-lines, max-lines-per-function -- sealed numerical model loading, clustering, and scoring stay co-located for auditability */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import * as ort from "onnxruntime-node";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type {
  CrossScriptProxyCandidateV1,
  FontMatchingPageInferenceBlock,
  VerifiedAutomaticFontPixelInferenceV2,
  VerifiedCrossScriptProxyInferenceV1,
} from "./fontMatchingPagePixelInferenceTypes";
import { isCrossScriptProxyEligibleBlock } from "./fontMatchingCrossScriptProxyPolicy";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";
import {
  CROSS_SCRIPT_PROXY_IMAGE_SIZE,
  CROSS_SCRIPT_PROXY_SUPPORT_COUNT,
  prepareCrossScriptProxySupport,
} from "./fontMatchingCrossScriptProxySupport";

const SCHEMA = "manga-font-crossscript-proxy-runtime-v2";
const OWNER = "carrot-manga-translator/manga-font-crossscript-proxy-runtime-v2";
const MARKER_FILE = ".owned.json";
const MANIFEST_FILE = "runtime-manifest.json";
const STYLE_MODEL_FILE = "style-encoder.onnx";
const DECODER_MODEL_FILE = "glyph-decoder.onnx";
const CANDIDATE_BANK_FILE = "candidate-glyphs.u8";
const EXPECTED_FILES = [
  MARKER_FILE,
  MANIFEST_FILE,
  STYLE_MODEL_FILE,
  DECODER_MODEL_FILE,
  CANDIDATE_BANK_FILE,
].sort();
const CACHE_SIDECAR_SUFFIXES = [".mgtmeta.json", ".mgt-sha256.json"] as const;
const STYLE_DIM = 192;
const GLYPH_COUNT = 24;
// Ordinary prose normally shares one page voice.  A second voice preserves a
// genuinely distinct treatment without forcing the four-way fragmentation
// that the visual production-path pilot exposed.
const VOICE_LIMIT = 2;
const MODEL_VERSION = "manga-font-crossscript-proxy-runtime-v2" as const;
const INFERENCE_CONTRACT =
  "font-matching-cross-script-proxy-inference-v2" as const;

type CandidateMetadata = Readonly<{
  bankByteLength: number;
  bankByteOffset: number;
  displayId: string;
  fontId: string;
  fontWeight: number;
  italic: boolean;
}>;

type CandidateScoreCache = Readonly<{
  bank: Uint8Array;
  edges: Float32Array;
  inkMasses: Float32Array;
  rowProjections: Float32Array;
  columnProjections: Float32Array;
}>;

type WeightCalibration = Readonly<{
  intercept: number;
  slope: number;
}>;

export type CrossScriptProxyRuntimeModel = Readonly<{
  candidateOrderSha256: string;
  candidates: readonly CandidateMetadata[];
  weightCalibration: WeightCalibration;
  scoreCache: CandidateScoreCache;
  styleSession: ort.InferenceSession;
  decoderSession: ort.InferenceSession;
}>;

type Manifest = Readonly<{
  candidateOrderSha256: string;
  candidates: readonly CandidateMetadata[];
  weightCalibration: WeightCalibration;
}>;

export async function loadCrossScriptProxyRuntimeModel(
  artifactDir: string,
): Promise<CrossScriptProxyRuntimeModel> {
  const root = resolve(artifactDir);
  await assertRuntimeDirectory(root);
  const marker = parseObject(await readFile(join(root, MARKER_FILE), "utf8"));
  const manifestRecord = parseObject(
    await readFile(join(root, MANIFEST_FILE), "utf8"),
  );
  assertIdentity(marker, manifestRecord);
  await verifyArtifacts(root, marker);
  const manifest = parseManifest(manifestRecord);
  const bankBuffer = await readFile(join(root, CANDIDATE_BANK_FILE));
  const bank = new Uint8Array(
    bankBuffer.buffer,
    bankBuffer.byteOffset,
    bankBuffer.byteLength,
  );
  const expectedBankLength =
    manifest.candidates.length *
    GLYPH_COUNT *
    CROSS_SCRIPT_PROXY_IMAGE_SIZE ** 2;
  if (bank.byteLength !== expectedBankLength) {
    throw new Error("Cross-script candidate glyph bank size drifted.");
  }
  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionMode: "sequential",
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    interOpNumThreads: 1,
    intraOpNumThreads: Math.max(1, Math.min(8, availableParallelism())),
  };
  const [styleSession, decoderSession] = await Promise.all([
    ort.InferenceSession.create(join(root, STYLE_MODEL_FILE), sessionOptions),
    ort.InferenceSession.create(join(root, DECODER_MODEL_FILE), sessionOptions),
  ]);
  assertSession(styleSession, ["support"], ["style"]);
  assertSession(decoderSession, ["style"], ["glyphs"]);
  return {
    candidateOrderSha256: manifest.candidateOrderSha256,
    candidates: manifest.candidates,
    weightCalibration: manifest.weightCalibration,
    scoreCache: prepareCandidateScoreCache(bank, manifest.candidates.length),
    styleSession,
    decoderSession,
  };
}

export async function inferCrossScriptProxyPage({
  blocks,
  candidates,
  existingRows,
  model,
  raster,
  signal,
  voiceLimit = VOICE_LIMIT,
}: Readonly<{
  blocks: readonly FontMatchingPageInferenceBlock[];
  candidates: readonly AutomaticFontCandidate[];
  existingRows: ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>;
  model: CrossScriptProxyRuntimeModel;
  raster: FontMatchingRasterPage;
  signal?: AbortSignal;
  voiceLimit?: number;
}>): Promise<ReadonlyMap<string, VerifiedCrossScriptProxyInferenceV1>> {
  throwIfAborted(signal);
  if (
    !Number.isInteger(voiceLimit) ||
    voiceLimit < 1 ||
    voiceLimit > VOICE_LIMIT
  ) {
    throw new Error(
      "Cross-script voice limit must be an integer from 1 through 2.",
    );
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.fontId));
  const runtimeCandidateIds = new Set(
    model.candidates.map((candidate) => candidate.fontId),
  );
  if (!sameSet(candidateIds, runtimeCandidateIds)) {
    throw new Error("Cross-script candidate catalog drifted.");
  }
  const prepared: Array<{
    block: FontMatchingPageInferenceBlock;
    inkMass: number;
    support: Float32Array;
  }> = [];
  for (const block of blocks) {
    if (
      !existingRows.has(block.blockId) ||
      !isCrossScriptProxyEligibleBlock(block) ||
      !block.sourceGlyphInput
    ) {
      continue;
    }
    const support = prepareCrossScriptProxySupport(
      raster,
      block.item.bbox,
      block.sourceGlyphInput,
      signal,
    );
    if (support)
      prepared.push({ block, inkMass: meanInkMass(support), support });
  }
  if (prepared.length === 0) return new Map();
  const supportData = new Float32Array(
    prepared.length *
      CROSS_SCRIPT_PROXY_SUPPORT_COUNT *
      CROSS_SCRIPT_PROXY_IMAGE_SIZE ** 2,
  );
  for (const [index, row] of prepared.entries()) {
    supportData.set(row.support, index * row.support.length);
  }
  const styleOutput = await model.styleSession.run({
    support: new ort.Tensor("float32", supportData, [
      prepared.length,
      CROSS_SCRIPT_PROXY_SUPPORT_COUNT,
      1,
      CROSS_SCRIPT_PROXY_IMAGE_SIZE,
      CROSS_SCRIPT_PROXY_IMAGE_SIZE,
    ]),
  });
  const styles = readFloatTensor(styleOutput.style, [
    prepared.length,
    STYLE_DIM,
  ]);
  const voiceCount = Math.min(voiceLimit, prepared.length);
  const assignments = deterministicKmeans(styles, prepared.length, voiceCount);
  const voiceStyles = meanVoiceStyles(
    styles,
    assignments,
    prepared.length,
    voiceCount,
  );
  const voiceInkMasses = meanVoiceInkMasses(prepared, assignments, voiceCount);
  throwIfAborted(signal);
  const glyphOutput = await model.decoderSession.run({
    style: new ort.Tensor("float32", voiceStyles, [voiceCount, STYLE_DIM]),
  });
  const glyphs = readFloatTensor(glyphOutput.glyphs, [
    voiceCount,
    GLYPH_COUNT,
    1,
    CROSS_SCRIPT_PROXY_IMAGE_SIZE,
    CROSS_SCRIPT_PROXY_IMAGE_SIZE,
  ]);
  const rankings = Array.from({ length: voiceCount }, (_unused, voice) =>
    rankVoiceCandidates(
      model,
      glyphs,
      voice,
      candidateIds,
      predictKoreanInkMass(model.weightCalibration, voiceInkMasses[voice] ?? 0),
      signal,
    ),
  );
  const output = new Map<string, VerifiedCrossScriptProxyInferenceV1>();
  for (const [index, row] of prepared.entries()) {
    const voice = assignments[index] ?? 0;
    const ranking = rankings[voice];
    if (!ranking?.length) continue;
    output.set(row.block.blockId, {
      kind: "verified_cross_script_proxy",
      contractVersion: INFERENCE_CONTRACT,
      modelVersion: MODEL_VERSION,
      voice: voice + 1,
      voiceCount,
      candidates: ranking,
    });
  }
  return output;
}

function deterministicKmeans(
  styles: Float32Array,
  rowCount: number,
  clusterCount: number,
): Int32Array {
  if (clusterCount <= 1) return new Int32Array(rowCount);
  const normalized = normalizeRows(styles, rowCount, STYLE_DIM);
  const centroids = new Float64Array(clusterCount * STYLE_DIM);
  centroids.set(normalized.subarray(0, STYLE_DIM), 0);
  let initialized = 1;
  while (initialized < clusterCount) {
    let bestIndex = 0;
    let bestDistance = -Infinity;
    for (let row = 0; row < rowCount; row += 1) {
      let nearest = Infinity;
      for (let cluster = 0; cluster < initialized; cluster += 1) {
        nearest = Math.min(
          nearest,
          1 - dotRows(normalized, row, centroids, cluster, STYLE_DIM),
        );
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = row;
      }
    }
    centroids.set(
      normalized.subarray(bestIndex * STYLE_DIM, (bestIndex + 1) * STYLE_DIM),
      initialized * STYLE_DIM,
    );
    initialized += 1;
  }
  let assignments = new Int32Array(rowCount);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const updated = new Int32Array(rowCount);
    let changed = false;
    for (let row = 0; row < rowCount; row += 1) {
      let bestCluster = 0;
      let bestDistance = Infinity;
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        const distance =
          1 - dotRows(normalized, row, centroids, cluster, STYLE_DIM);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = cluster;
        }
      }
      updated[row] = bestCluster;
      if (bestCluster !== assignments[row]) changed = true;
    }
    assignments = updated;
    const next = new Float64Array(centroids.length);
    const counts = new Int32Array(clusterCount);
    for (let row = 0; row < rowCount; row += 1) {
      const cluster = assignments[row] ?? 0;
      counts[cluster] += 1;
      for (let feature = 0; feature < STYLE_DIM; feature += 1) {
        next[cluster * STYLE_DIM + feature] +=
          normalized[row * STYLE_DIM + feature] ?? 0;
      }
    }
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      if (!counts[cluster]) {
        next.set(
          centroids.subarray(cluster * STYLE_DIM, (cluster + 1) * STYLE_DIM),
          cluster * STYLE_DIM,
        );
        continue;
      }
      normalizeRowInPlace(next, cluster, STYLE_DIM);
    }
    centroids.set(next);
    if (!changed && iteration > 0) break;
  }
  return assignments;
}

function meanVoiceStyles(
  styles: Float32Array,
  assignments: Int32Array,
  rowCount: number,
  voiceCount: number,
): Float32Array {
  const output = new Float32Array(voiceCount * STYLE_DIM);
  const counts = new Int32Array(voiceCount);
  for (let row = 0; row < rowCount; row += 1) {
    const voice = assignments[row] ?? 0;
    counts[voice] += 1;
    for (let feature = 0; feature < STYLE_DIM; feature += 1) {
      output[voice * STYLE_DIM + feature] +=
        styles[row * STYLE_DIM + feature] ?? 0;
    }
  }
  for (let voice = 0; voice < voiceCount; voice += 1) {
    const count = counts[voice] || 1;
    for (let feature = 0; feature < STYLE_DIM; feature += 1) {
      output[voice * STYLE_DIM + feature] /= count;
    }
  }
  return output;
}

function meanVoiceInkMasses(
  rows: readonly { inkMass: number }[],
  assignments: Int32Array,
  voiceCount: number,
): Float64Array {
  const output = new Float64Array(voiceCount);
  const counts = new Uint32Array(voiceCount);
  for (const [index, row] of rows.entries()) {
    const voice = assignments[index] ?? 0;
    output[voice] += row.inkMass;
    counts[voice] += 1;
  }
  for (let voice = 0; voice < voiceCount; voice += 1) {
    output[voice] /= Math.max(1, counts[voice] ?? 0);
  }
  return output;
}

function meanInkMass(values: Float32Array): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / Math.max(1, values.length);
}

function predictKoreanInkMass(
  calibration: WeightCalibration,
  sourceInkMass: number,
): number {
  return Math.max(
    0,
    Math.min(1, calibration.intercept + calibration.slope * sourceInkMass),
  );
}

function rankVoiceCandidates(
  model: CrossScriptProxyRuntimeModel,
  glyphs: Float32Array,
  voice: number,
  activeIds: ReadonlySet<string>,
  predictedInkMass: number,
  signal?: AbortSignal,
): CrossScriptProxyCandidateV1[] {
  const pixelsPerGlyph = CROSS_SCRIPT_PROXY_IMAGE_SIZE ** 2;
  const pixelsPerVoice = GLYPH_COUNT * pixelsPerGlyph;
  const start = voice * pixelsPerVoice;
  const generated = glyphs.subarray(start, start + pixelsPerVoice);
  const generatedEdges = computeSobelVolume(generated, GLYPH_COUNT);
  const generatedRows = computeRowProjections(generated, GLYPH_COUNT);
  const generatedColumns = computeColumnProjections(generated, GLYPH_COUNT);
  const scored = model.candidates
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate }) => activeIds.has(candidate.fontId))
    .map(({ candidate, candidateIndex }) => {
      throwIfAborted(signal);
      return {
        candidate,
        inkMass: model.scoreCache.inkMasses[candidateIndex] ?? 0,
        score: candidateScore({
          candidateIndex,
          generated,
          generatedColumns,
          generatedEdges,
          generatedRows,
          scoreCache: model.scoreCache,
        }),
      };
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        compareStrings(left.candidate.displayId, right.candidate.displayId),
    );
  const families = new Map<string, typeof scored>();
  for (const row of scored) {
    const family = families.get(row.candidate.fontId) ?? [];
    family.push(row);
    families.set(row.candidate.fontId, family);
  }
  return [...families.values()]
    .map((family) => {
      const familyBest = family[0];
      if (!familyBest) throw new Error("Cross-script family became empty.");
      const face = selectCrossScriptProxyWeightFace(family, predictedInkMass);
      return {
        fontId: face.candidate.fontId,
        displayId: face.candidate.displayId,
        score: familyBest.score,
        fontWeight: face.candidate.fontWeight,
        italic: face.candidate.italic,
      };
    })
    .sort(
      (left, right) =>
        left.score - right.score || compareStrings(left.fontId, right.fontId),
    );
}

export function selectCrossScriptProxyWeightFace<
  T extends Readonly<{
    candidate: Readonly<{ displayId: string; fontWeight: number }>;
    inkMass: number;
    score: number;
  }>,
>(rows: readonly T[], predictedInkMass: number): T {
  const selected = [...rows].sort(
    (left, right) =>
      Math.abs(left.inkMass - predictedInkMass) -
        Math.abs(right.inkMass - predictedInkMass) ||
      left.score - right.score ||
      left.candidate.fontWeight - right.candidate.fontWeight ||
      compareStrings(left.candidate.displayId, right.candidate.displayId),
  )[0];
  if (!selected) throw new Error("Cross-script weight face became empty.");
  return selected;
}

function candidateScore(options: {
  candidateIndex: number;
  generated: Float32Array;
  generatedColumns: Float32Array;
  generatedEdges: Float32Array;
  generatedRows: Float32Array;
  scoreCache: CandidateScoreCache;
}): number {
  const volume = GLYPH_COUNT * CROSS_SCRIPT_PROXY_IMAGE_SIZE ** 2;
  const offset = options.candidateIndex * volume;
  let pixelDifference = 0;
  let edgeDifference = 0;
  for (let index = 0; index < volume; index += 1) {
    pixelDifference += Math.abs(
      (options.generated[index] ?? 0) -
        (options.scoreCache.bank[offset + index] ?? 0) / 255,
    );
    edgeDifference += Math.abs(
      (options.generatedEdges[index] ?? 0) -
        (options.scoreCache.edges[offset + index] ?? 0),
    );
  }
  const projectionWidth = GLYPH_COUNT * CROSS_SCRIPT_PROXY_IMAGE_SIZE;
  const projectionOffset = options.candidateIndex * projectionWidth;
  let rowDifference = 0;
  let columnDifference = 0;
  for (let index = 0; index < projectionWidth; index += 1) {
    rowDifference += Math.abs(
      (options.generatedRows[index] ?? 0) -
        (options.scoreCache.rowProjections[projectionOffset + index] ?? 0),
    );
    columnDifference += Math.abs(
      (options.generatedColumns[index] ?? 0) -
        (options.scoreCache.columnProjections[projectionOffset + index] ?? 0),
    );
  }
  const projection =
    0.5 *
    (rowDifference / projectionWidth + columnDifference / projectionWidth);
  return (
    pixelDifference / volume +
    0.35 * (edgeDifference / volume) +
    0.5 * projection
  );
}

function prepareCandidateScoreCache(
  bank: Uint8Array,
  candidateCount: number,
): CandidateScoreCache {
  const volume = GLYPH_COUNT * CROSS_SCRIPT_PROXY_IMAGE_SIZE ** 2;
  const projectionWidth = GLYPH_COUNT * CROSS_SCRIPT_PROXY_IMAGE_SIZE;
  const edges = new Float32Array(candidateCount * volume);
  const inkMasses = new Float32Array(candidateCount);
  const rowProjections = new Float32Array(candidateCount * projectionWidth);
  const columnProjections = new Float32Array(candidateCount * projectionWidth);
  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    const values = new Float32Array(volume);
    const offset = candidate * volume;
    for (let index = 0; index < volume; index += 1) {
      values[index] = (bank[offset + index] ?? 0) / 255;
    }
    inkMasses[candidate] = meanInkMass(values);
    edges.set(computeSobelVolume(values, GLYPH_COUNT), offset);
    rowProjections.set(
      computeRowProjections(values, GLYPH_COUNT),
      candidate * projectionWidth,
    );
    columnProjections.set(
      computeColumnProjections(values, GLYPH_COUNT),
      candidate * projectionWidth,
    );
  }
  return { bank, edges, inkMasses, rowProjections, columnProjections };
}

function computeSobelVolume(
  values: Float32Array,
  glyphCount: number,
): Float32Array {
  const size = CROSS_SCRIPT_PROXY_IMAGE_SIZE;
  const output = new Float32Array(values.length);
  const kernelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const kernelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  const glyphPixels = size * size;
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const base = glyph * glyphPixels;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let horizontal = 0;
        let vertical = 0;
        let kernel = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const sx = x + dx;
            const sy = y + dy;
            const value =
              sx < 0 || sx >= size || sy < 0 || sy >= size
                ? 0
                : (values[base + sy * size + sx] ?? 0);
            horizontal += value * (kernelX[kernel] ?? 0);
            vertical += value * (kernelY[kernel] ?? 0);
            kernel += 1;
          }
        }
        output[base + y * size + x] = Math.sqrt(
          horizontal * horizontal + vertical * vertical + 1e-8,
        );
      }
    }
  }
  return output;
}

function computeRowProjections(
  values: Float32Array,
  glyphCount: number,
): Float32Array {
  const size = CROSS_SCRIPT_PROXY_IMAGE_SIZE;
  const output = new Float32Array(glyphCount * size);
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const base = glyph * size * size;
    for (let y = 0; y < size; y += 1) {
      let sum = 0;
      for (let x = 0; x < size; x += 1) {
        sum += values[base + y * size + x] ?? 0;
      }
      output[glyph * size + y] = sum / size;
    }
  }
  return output;
}

function computeColumnProjections(
  values: Float32Array,
  glyphCount: number,
): Float32Array {
  const size = CROSS_SCRIPT_PROXY_IMAGE_SIZE;
  const output = new Float32Array(glyphCount * size);
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    const base = glyph * size * size;
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      for (let y = 0; y < size; y += 1) {
        sum += values[base + y * size + x] ?? 0;
      }
      output[glyph * size + x] = sum / size;
    }
  }
  return output;
}

function normalizeRows(
  values: Float32Array,
  rows: number,
  width: number,
): Float64Array {
  const output = new Float64Array(values.length);
  for (let row = 0; row < rows; row += 1) {
    let squared = 0;
    for (let index = 0; index < width; index += 1) {
      const value = values[row * width + index] ?? 0;
      squared += value * value;
    }
    const norm = Math.sqrt(squared) || 1;
    for (let index = 0; index < width; index += 1) {
      output[row * width + index] = (values[row * width + index] ?? 0) / norm;
    }
  }
  return output;
}

function normalizeRowInPlace(
  values: Float64Array,
  row: number,
  width: number,
): void {
  let squared = 0;
  for (let index = 0; index < width; index += 1) {
    const value = values[row * width + index] ?? 0;
    squared += value * value;
  }
  const norm = Math.sqrt(squared) || 1;
  for (let index = 0; index < width; index += 1) {
    values[row * width + index] /= norm;
  }
}

function dotRows(
  left: Float64Array,
  leftRow: number,
  right: Float64Array,
  rightRow: number,
  width: number,
): number {
  let sum = 0;
  for (let index = 0; index < width; index += 1) {
    sum +=
      (left[leftRow * width + index] ?? 0) *
      (right[rightRow * width + index] ?? 0);
  }
  return sum;
}

function readFloatTensor(
  value: ort.Tensor | undefined,
  expectedDimensions: readonly number[],
): Float32Array {
  if (
    !value ||
    value.type !== "float32" ||
    !sameArray(value.dims, expectedDimensions) ||
    !(value.data instanceof Float32Array)
  ) {
    throw new Error("Cross-script ONNX output contract drifted.");
  }
  return value.data;
}

function parseManifest(value: Readonly<Record<string, unknown>>): Manifest {
  const candidateOrderSha256 = value.candidate_order_sha256;
  const rawCandidates = value.candidates;
  if (
    typeof candidateOrderSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidateOrderSha256) ||
    !Array.isArray(rawCandidates) ||
    rawCandidates.length !== 41
  ) {
    throw new Error("Cross-script runtime manifest contract drifted.");
  }
  const candidates = rawCandidates.map(parseCandidate);
  const weightCalibration = parseWeightCalibration(value.weight_calibration);
  const volume = GLYPH_COUNT * CROSS_SCRIPT_PROXY_IMAGE_SIZE ** 2;
  for (const [index, candidate] of candidates.entries()) {
    if (
      candidate.bankByteOffset !== index * volume ||
      candidate.bankByteLength !== volume
    ) {
      throw new Error("Cross-script candidate bank binding drifted.");
    }
  }
  return { candidateOrderSha256, candidates, weightCalibration };
}

function parseWeightCalibration(value: unknown): WeightCalibration {
  const record = requireRecord(value);
  const intercept = readFiniteNumber(record.intercept);
  const slope = readFiniteNumber(record.slope);
  if (
    record.kind !== "paired_cross_script_linear_ink_mass_v1" ||
    record.input !== "mean_canonical_japanese_support_ink" ||
    record.target !== "mean_canonical_korean_probe_ink" ||
    intercept === null ||
    slope === null ||
    slope <= 0
  ) {
    throw new Error("Cross-script weight calibration drifted.");
  }
  return { intercept, slope };
}

function parseCandidate(value: unknown): CandidateMetadata {
  const record = requireRecord(value);
  const bankByteLength = readInteger(record.bank_byte_length, 1);
  const bankByteOffset = readInteger(record.bank_byte_offset, 0);
  const fontWeight = readInteger(record.font_weight, 1);
  const displayId = readString(record.display_id);
  const fontId = readString(record.font_id);
  if (
    bankByteLength === null ||
    bankByteOffset === null ||
    fontWeight === null ||
    !displayId ||
    !fontId ||
    typeof record.italic !== "boolean"
  ) {
    throw new Error("Cross-script candidate metadata drifted.");
  }
  return {
    bankByteLength,
    bankByteOffset,
    displayId,
    fontId,
    fontWeight,
    italic: record.italic,
  };
}

function assertIdentity(
  marker: Readonly<Record<string, unknown>>,
  manifest: Readonly<Record<string, unknown>>,
): void {
  if (
    marker.schema_version !== SCHEMA ||
    marker.owner !== OWNER ||
    marker.safe_replace !== true ||
    manifest.schema_version !== SCHEMA ||
    manifest.owner !== OWNER ||
    manifest.status !== "production_connected_user_approved_visual_pilot" ||
    manifest.production_connected !== true
  ) {
    throw new Error("Cross-script runtime identity drifted.");
  }
}

async function assertRuntimeDirectory(root: string): Promise<void> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Cross-script runtime must be a regular directory.");
  }
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const allowed = new Set([
    ...EXPECTED_FILES,
    ...EXPECTED_FILES.flatMap((fileName) =>
      CACHE_SIDECAR_SUFFIXES.map((suffix) => `${fileName}${suffix}`),
    ),
  ]);
  if (
    entries.some(
      (entry) =>
        !entry.isFile() || entry.isSymbolicLink() || !allowed.has(entry.name),
    ) ||
    EXPECTED_FILES.some((fileName) => !names.includes(fileName))
  ) {
    throw new Error("Cross-script runtime inventory drifted.");
  }
}

async function verifyArtifacts(
  root: string,
  marker: Readonly<Record<string, unknown>>,
): Promise<void> {
  const artifacts = requireRecord(marker.artifacts);
  if (
    !sameArray(Object.keys(artifacts).sort(), EXPECTED_FILES.slice(1).sort())
  ) {
    throw new Error("Cross-script marker inventory drifted.");
  }
  for (const name of EXPECTED_FILES.slice(1)) {
    const path = join(root, name);
    const metadata = await lstat(path);
    const descriptor = requireRecord(artifacts[name]);
    const bytes = await readFile(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      descriptor.file !== name ||
      descriptor.byte_size !== bytes.byteLength ||
      descriptor.sha256 !== sha256(bytes)
    ) {
      throw new Error(`Cross-script runtime artifact drifted: ${name}`);
    }
  }
}

function assertSession(
  session: ort.InferenceSession,
  inputs: readonly string[],
  outputs: readonly string[],
): void {
  if (
    !sameArray(session.inputNames, inputs) ||
    !sameArray(session.outputNames, outputs)
  ) {
    throw new Error("Cross-script ONNX session names drifted.");
  }
}

function parseObject(text: string): Readonly<Record<string, unknown>> {
  return requireRecord(JSON.parse(text) as unknown);
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cross-script runtime record is malformed.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function readInteger(value: unknown, minimum: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameArray(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
