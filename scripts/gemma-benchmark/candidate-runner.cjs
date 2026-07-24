/**
 * @typedef {{ name: string; batch?: number; ubatch?: number; ctx?: number; fitTargetMb?: number; imageMinTokens?: number; imageMaxTokens?: number; kvOffload?: boolean; mmprojOffload?: boolean; gpuLayers?: number | string; noHost?: boolean; serverPath?: string; modelRepo?: string; modelFile?: string; mmprojRepo?: string; mmprojFile?: string; cacheTypeK?: string; cacheTypeV?: string; extraArgs?: string[]; threads?: number; threadsBatch?: number; poll?: number; pollBatch?: boolean; prioBatch?: number; cacheIdleSlots?: unknown; cacheReuse?: unknown; [key: string]: unknown }} BenchmarkCandidate
 * @typedef {{ id: string; name: string; imagePath: string; width: number; height: number }} BenchmarkSample
 * @typedef {{ serverLogPath?: string; [key: string]: unknown }} BenchmarkOptions
 * @typedef {{ prompt_per_second?: unknown; predicted_per_second?: unknown; [key: string]: unknown }} BenchmarkTimings
 * @typedef {{ runIndex: number; sampleIndex: number; imagePath: string; wallMs: number; blockCount: number; timings: BenchmarkTimings | null; gpu: any }} MeasuredPage
 * @typedef {{ name: string; candidate: BenchmarkCandidate; failed?: boolean; serverPid: number | null; serverLog?: any; beforeStart: any; afterStart?: any; afterStop: any; pages: MeasuredPage[]; measured: any; error?: { message: string; stack: unknown; candidateIndex: number } }} BenchmarkResult
 * @typedef {{ child?: { pid?: number | null } | null; [key: string]: unknown }} ServerLike
 * @typedef {{ buildLaunchArgs(options: BenchmarkOptions): string[]; requestTranslation(server: ServerLike, options: BenchmarkOptions): Promise<any>; saveArtifacts(options: BenchmarkOptions, result: any): Promise<void>; startServer(options: BenchmarkOptions): Promise<ServerLike>; stopServer(server: ServerLike): Promise<void> }} SimplePageModule
 * @typedef {{ parseJsonLenient(rawText: string): unknown; normalizeItems(parsed: unknown): unknown[] }} OverlayToolsModule
 * @typedef {{ candidate: BenchmarkCandidate; candidateIndex: number; baseOptions: BenchmarkOptions; simplePage: SimplePageModule; overlayTools: OverlayToolsModule; samples: BenchmarkSample[]; ocrHintsByPath: Map<string, unknown[]>; outDir: string }} RunCandidateOptions
 * @typedef {{ candidate: BenchmarkCandidate; candidateDir: string; options: BenchmarkOptions; pid: number | null; server: ServerLike; simplePage: SimplePageModule; overlayTools: OverlayToolsModule; samples: BenchmarkSample[]; ocrHintsByPath: Map<string, unknown[]> }} CandidateMeasurementOptions
 * @typedef {{ candidate: BenchmarkCandidate; candidateIndex: number; outDir: string; error: unknown }} FailedCandidateOptions
 */
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { BASE_PORT, RUNS_PER_CANDIDATE } = require("./config.cjs");
const {
  measureGpuDuring,
  readGpuSnapshot,
  summarizeGpuSamples,
  summarizeMeasuredPages,
} = require("./metrics.cjs");
const { readTextIfExists, summarizeServerLog } = require("./samples.cjs");

/**
 * @param {RunCandidateOptions} options
 * @returns {Promise<BenchmarkResult>}
 */
async function runCandidate({
  candidate,
  candidateIndex,
  baseOptions,
  simplePage,
  overlayTools,
  samples,
  ocrHintsByPath,
  outDir,
}) {
  const candidateDir = path.join(outDir, "candidates", candidate.name);
  await mkdir(candidateDir, { recursive: true });
  const options = buildCandidateOptions(
    candidate,
    candidateIndex,
    baseOptions,
    candidateDir,
  );
  const launchArgs = simplePage.buildLaunchArgs(options);
  await writeFile(
    path.join(candidateDir, "launch-args.txt"),
    `${launchArgs.join(" ")}\n`,
    "utf8",
  );

  console.log(`[perf] start ${candidate.name}`);
  const beforeStart = readGpuSnapshot(null);
  const server = await simplePage.startServer(options);
  const pid = server.child?.pid ?? null;
  const afterStart = readGpuSnapshot(pid);
  let pages;
  try {
    pages = await measureCandidatePages({
      candidate,
      candidateDir,
      options,
      pid,
      server,
      simplePage,
      overlayTools,
      samples,
      ocrHintsByPath,
    });
  } finally {
    await simplePage.stopServer(server);
  }
  const serverLogText = await readTextIfExists(options.serverLogPath);
  const afterStop = readGpuSnapshot(null);
  const result = {
    name: candidate.name,
    candidate,
    serverLog: {
      path: options.serverLogPath,
      ...summarizeServerLog(serverLogText),
    },
    beforeStart,
    afterStart,
    afterStop,
    serverPid: pid,
    pages,
    measured: summarizeMeasuredPages(pages, beforeStart),
  };
  await writeFile(
    path.join(candidateDir, "summary.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  return result;
}

/**
 * @param {BenchmarkCandidate} candidate
 * @param {number} candidateIndex
 * @param {BenchmarkOptions} base
 * @param {string} candidateDir
 */
function buildCandidateOptions(candidate, candidateIndex, base, candidateDir) {
  /** @type {(value: unknown, fallback: unknown) => unknown} */
  const prefer = (value, fallback) =>
    value === undefined || value === null ? fallback : value;
  return {
    ...base,
    port: BASE_PORT + candidateIndex,
    serverLogPath: path.join(candidateDir, "server.log"),
    ctx: prefer(candidate.ctx, base.ctx),
    batch: candidate.batch,
    ubatch: candidate.ubatch,
    fitTargetMb: prefer(candidate.fitTargetMb, base.fitTargetMb),
    imageMinTokens: prefer(candidate.imageMinTokens, base.imageMinTokens),
    imageMaxTokens: prefer(candidate.imageMaxTokens, base.imageMaxTokens),
    extraArgs: candidate.extraArgs,
    threads: candidate.threads,
    threadsBatch: candidate.threadsBatch,
    poll: candidate.poll,
    pollBatch: candidate.pollBatch,
    prioBatch: candidate.prioBatch,
    cacheIdleSlots: candidate.cacheIdleSlots,
    cacheReuse: candidate.cacheReuse,
    kvOffload: prefer(candidate.kvOffload, base.kvOffload),
    mmprojOffload: prefer(candidate.mmprojOffload, base.mmprojOffload),
    gpuLayers: prefer(candidate.gpuLayers, base.gpuLayers),
    noHost: prefer(candidate.noHost, base.noHost),
    serverPath: prefer(candidate.serverPath, base.serverPath),
    modelRepo: prefer(candidate.modelRepo, base.modelRepo),
    modelFile: prefer(candidate.modelFile, base.modelFile),
    mmprojRepo: prefer(candidate.mmprojRepo, base.mmprojRepo),
    mmprojFile: prefer(candidate.mmprojFile, base.mmprojFile),
    cacheTypeK: prefer(candidate.cacheTypeK, base.cacheTypeK),
    cacheTypeV: prefer(candidate.cacheTypeV, base.cacheTypeV),
    enableMetrics: true,
    enablePerf: true,
    useDraft: false,
    gemmaVramMode: "economy",
    label: `perf-${candidate.name}`,
  };
}

/** @param {CandidateMeasurementOptions} input */
async function measureCandidatePages(input) {
  /** @type {MeasuredPage[]} */
  const pages = [];
  for (let runIndex = 0; runIndex < RUNS_PER_CANDIDATE; runIndex += 1) {
    for (const [sampleIndex, sample] of input.samples.entries()) {
      pages.push(
        await measureCandidatePage(input, runIndex, sampleIndex, sample),
      );
    }
  }
  return pages;
}

/**
 * @param {CandidateMeasurementOptions} input
 * @param {number} runIndex
 * @param {number} sampleIndex
 * @param {BenchmarkSample} sample
 */
async function measureCandidatePage(input, runIndex, sampleIndex, sample) {
  const pageDir = path.join(
    input.candidateDir,
    `run-${runIndex + 1}`,
    `page-${sampleIndex + 1}`,
  );
  await mkdir(pageDir, { recursive: true });
  const pageOptions = {
    ...input.options,
    imagePath: sample.imagePath,
    imageWidth: sample.width,
    imageHeight: sample.height,
    outputDir: pageDir,
    label: `perf-${input.candidate.name}-r${runIndex + 1}-p${sampleIndex + 1}`,
    ocrBboxHints: input.ocrHintsByPath.get(sample.imagePath) ?? [],
  };
  const measured = await measureGpuDuring(input.pid, () =>
    input.simplePage.requestTranslation(input.server, pageOptions),
  );
  await input.simplePage.saveArtifacts(pageOptions, measured.result);
  const parsed = input.overlayTools.parseJsonLenient(
    measured.result.outputText,
  );
  const items = input.overlayTools.normalizeItems(parsed);
  const pageResult = {
    runIndex,
    sampleIndex,
    imagePath: sample.imagePath,
    wallMs: measured.wallMs,
    blockCount: items.length,
    timings: measured.result.rawResponse?.timings ?? null,
    gpu: summarizeGpuSamples(measured.gpuSamples),
  };
  await writeFile(
    path.join(pageDir, "perf.json"),
    `${JSON.stringify(pageResult, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[perf] ${input.candidate.name} r${runIndex + 1} p${sampleIndex + 1}: ${pageResult.wallMs}ms, blocks=${items.length}`,
  );
  return pageResult;
}

/**
 * @param {FailedCandidateOptions} options
 * @returns {Promise<BenchmarkResult>}
 */
async function writeFailedCandidateResult({
  candidate,
  candidateIndex,
  outDir,
  error,
}) {
  const candidateDir = path.join(outDir, "candidates", candidate.name);
  await mkdir(candidateDir, { recursive: true });
  const result = {
    name: candidate.name,
    candidate,
    failed: true,
    serverPid: null,
    serverLog: {
      path: path.join(candidateDir, "server.log"),
      imageTokenClipped: false,
      lastCudaMemoryBreakdown: null,
    },
    beforeStart: null,
    afterStart: null,
    afterStop: readGpuSnapshot(null),
    pages: [],
    measured: {
      measuredPageCount: 0,
      meanWallMs: Number.POSITIVE_INFINITY,
      meanPromptTokensPerSecond: null,
      meanPredictedTokensPerSecond: null,
      peakProcessVramMb: null,
      peakGpuDeltaMb: Number.POSITIVE_INFINITY,
      peakGpuUsedMb: null,
      minBlockCount: 0,
      maxBlockCount: 0,
    },
    error: {
      message:
        error && typeof error === "object" && "message" in error
          ? String(/** @type {{ message?: unknown }} */ (error).message)
          : String(error),
      stack:
        error && typeof error === "object" && "stack" in error
          ? /** @type {{ stack?: unknown }} */ (error.stack ?? null)
          : null,
      candidateIndex,
    },
  };
  await writeFile(
    path.join(candidateDir, "summary.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  console.warn(`[perf] ${candidate.name} failed: ${result.error.message}`);
  return result;
}

module.exports = { runCandidate, writeFailedCandidateResult };
