const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, nativeImage } = require("electron");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SAMPLE_PATHS = [
  "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas\\Manga Mura (JA)\\転生しました、サラナ・キンジェです。ごきげんよう。 ～優雅なスローライフで大忙し～ 転生しました、サラナ・キンジェです。ごきげんよう。 ～婚約破棄されたので田舎で気ままに暮らしたいと思います～\\第3話_ 第3話\\003.jpeg",
  "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas\\Rawkuma (JA)\\Akuyaku ga Ippai Detekuru Eroge no Kimo Debu Akuyaku Kizoku ni Tensei Shita\\Chapter 3.1\\001.jpeg",
  "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas\\Rawkuma (JA)\\Danshi Koukousei, Otome Game no Akuyaku Reijou ni Tensei Suru\\Chapter 2\\001.jpeg"
];

const RUNS_PER_CANDIDATE = readIntEnv("MANGA_PERF_RUNS", 2);
const GPU_SAMPLE_INTERVAL_MS = readIntEnv("MANGA_PERF_GPU_SAMPLE_INTERVAL_MS", 1000);
const VRAM_DELTA_LIMIT_MB = readIntEnv("MANGA_PERF_VRAM_DELTA_LIMIT_MB", 300);
const MIN_WALL_IMPROVEMENT = readNumberEnv("MANGA_PERF_MIN_WALL_IMPROVEMENT", 0.05);
const BASE_PORT = readIntEnv("MANGA_PERF_BASE_PORT", 18240);
const CPU_THREAD_GUESS = Math.max(4, Math.min(os.cpus().length || 8, 16));

const CANDIDATES = [
  { name: "baseline-b1024-ub1024", batch: 1024, ubatch: 1024 },
  { name: "b512-ub1024", batch: 512, ubatch: 1024 },
  { name: "b1536-ub1024", batch: 1536, ubatch: 1024 },
  { name: "gpu-kv-b1024-ub1024", batch: 1024, ubatch: 1024, kvOffload: true },
  { name: "gpu-kv-b1024-ub768", batch: 1024, ubatch: 768, kvOffload: true },
  { name: "gpu-kv-b1024-ub512", batch: 1024, ubatch: 512, kvOffload: true },
  { name: "gpu-kv-vturbo4", batch: 1024, ubatch: 1024, kvOffload: true, cacheTypeK: "q4_0", cacheTypeV: "turbo4" },
  { name: "gpu-kv-turbo4", batch: 1024, ubatch: 1024, kvOffload: true, cacheTypeK: "turbo4", cacheTypeV: "turbo4" },
  { name: "gpu-kv-vturbo3", batch: 1024, ubatch: 1024, kvOffload: true, cacheTypeK: "q4_0", cacheTypeV: "turbo3" },
  { name: "gpu-kv-turbo3", batch: 1024, ubatch: 1024, kvOffload: true, cacheTypeK: "turbo3", cacheTypeV: "turbo3" },
  { name: "gpu-kv-turbo3-tcq", batch: 1024, ubatch: 1024, kvOffload: true, cacheTypeK: "turbo3_tcq", cacheTypeV: "turbo3_tcq" },
  { name: "gpu-kv-turbo2", batch: 1024, ubatch: 1024, kvOffload: true, cacheTypeK: "turbo2", cacheTypeV: "turbo2" },
  { name: "mmproj-gpu-cpu-kv", batch: 1024, ubatch: 1024, kvOffload: false, mmprojOffload: true },
  { name: "mmproj-gpu-gpu-kv", batch: 1024, ubatch: 1024, kvOffload: true, mmprojOffload: true },
  { name: "mmproj-gpu-gpu-kv-ub768", batch: 1024, ubatch: 768, kvOffload: true, mmprojOffload: true },
  { name: "mmproj-gpu-gpu-kv-ub512", batch: 1024, ubatch: 512, kvOffload: true, mmprojOffload: true },
  { name: "mmproj-gpu-gpu-kv-ctx6144-ub512", batch: 1024, ubatch: 512, ctx: 6144, kvOffload: true, mmprojOffload: true },
  {
    name: "mmproj-gpu-gpu-kv-turbo4",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    mmprojOffload: true,
    cacheTypeK: "turbo4",
    cacheTypeV: "turbo4"
  },
  {
    name: "mmproj-gpu-gpu-kv-turbo3",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    mmprojOffload: true,
    cacheTypeK: "turbo3",
    cacheTypeV: "turbo3"
  },
  { name: "gpu-kv-ctx4096", batch: 1024, ubatch: 1024, ctx: 4096, kvOffload: true },
  { name: "gpu-kv-ctx5120", batch: 1024, ubatch: 1024, ctx: 5120, kvOffload: true },
  { name: "gpu-kv-ctx6144", batch: 1024, ubatch: 1024, ctx: 6144, kvOffload: true },
  { name: "gpu-kv-ctx7168", batch: 1024, ubatch: 1024, ctx: 7168, kvOffload: true },
  { name: "gpu-kv-ctx7680", batch: 1024, ubatch: 1024, ctx: 7680, kvOffload: true },
  { name: "gpu-kv-no-warmup", batch: 1024, ubatch: 1024, kvOffload: true, extraArgs: ["--no-warmup"] },
  {
    name: "gpu-kv-swa768",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--override-kv", "gemma4.attention.sliding_window=int:768"]
  },
  {
    name: "gpu-kv-swa512",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--override-kv", "gemma4.attention.sliding_window=int:512"]
  },
  { name: "gpu-kv-no-repack", batch: 1024, ubatch: 1024, kvOffload: true, extraArgs: ["--no-repack"] },
  { name: "gpu-kv-no-op-offload", batch: 1024, ubatch: 1024, kvOffload: true, extraArgs: ["--no-op-offload"] },
  {
    name: "gpu-kv-no-repack-no-op-offload",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--no-repack", "--no-op-offload"]
  },
  { name: "gpu-kv-b512-ub1024", batch: 512, ubatch: 1024, kvOffload: true },
  { name: "cpu-feed-b1024-ub1024", batch: 1024, ubatch: 1024, poll: 100, pollBatch: true, prioBatch: 2, threadsBatch: CPU_THREAD_GUESS },
  { name: "cpu-feed-b1536-ub1024", batch: 1536, ubatch: 1024, poll: 100, pollBatch: true, prioBatch: 2, threadsBatch: CPU_THREAD_GUESS },
  { name: "cpu-feed-b1536-ub1536", batch: 1536, ubatch: 1536, poll: 100, pollBatch: true, prioBatch: 2, threadsBatch: CPU_THREAD_GUESS }
];
const CANDIDATE_FILTER = String(process.env.MANGA_PERF_CANDIDATES || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

async function main() {
  app.setPath("userData", path.join(ROOT, ".tmp", "perf-gemma-economy", "electron-user-data"));
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disk-cache-size", "0");
  app.on("window-all-closed", (event) => event.preventDefault());
  await app.whenReady();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(ROOT, ".tmp", "perf-gemma-economy", timestamp);
  const pagesDir = path.join(outDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  const { getAppPaths } = require("../out/main/appPaths.js");
  const { normalizeAppSettings, buildBaseTranslationOptions } = require("../out/main/appSettings.js");
  const simplePage = require("../out/app-runtime/simple-page-translate.cjs");
  const overlayTools = require("../out/app-runtime/overlay-parser.cjs");

  const paths = getAppPaths();
  const settings = normalizeAppSettings(await readJsonIfExists(paths.settingsPath));
  settings.modelProvider = "gemma";
  settings.gemma.vramMode = "economy";

  const baseOptions = buildBaseTranslationOptions({
    jobId: "perf-gemma-economy",
    runDir: path.join(outDir, "runs"),
    paths,
    settings
  });

  const samples = resolveSamples().map((imagePath, index) => createPageRecord(imagePath, index));
  const candidates = (CANDIDATE_FILTER.length > 0
    ? CANDIDATES.filter((candidate) => CANDIDATE_FILTER.includes(candidate.name))
    : CANDIDATES).filter((candidate) => candidateKeepsImageTokenBudget(candidate, baseOptions));
  if (samples.length === 0) {
    throw new Error("No benchmark sample images found.");
  }
  if (candidates.length === 0) {
    throw new Error(`No benchmark candidates matched: ${CANDIDATE_FILTER.join(", ")}`);
  }
  await writeFile(path.join(outDir, "samples.json"), `${JSON.stringify(samples, null, 2)}\n`, "utf8");

  console.log(`[perf] writing ${outDir}`);
  console.log(`[perf] samples=${samples.length}, candidates=${candidates.length}, runs=${RUNS_PER_CANDIDATE}`);

  const ocrHintsByPath = await prepareCachedOcrHints(simplePage, baseOptions, samples, pagesDir);
  const results = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    let candidateResult;
    try {
      candidateResult = await runCandidate({
        candidate,
        candidateIndex,
        baseOptions,
        simplePage,
        overlayTools,
        samples,
        ocrHintsByPath,
        outDir
      });
    } catch (error) {
      candidateResult = await writeFailedCandidateResult({
        candidate,
        candidateIndex,
        outDir,
        error
      });
    }
    results.push(candidateResult);
    await writeFile(path.join(outDir, "results.partial.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  }

  const summary = summarizeResults(results);
  await writeFile(path.join(outDir, "results.json"), `${JSON.stringify({ summary, results }, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "report.md"), buildMarkdownReport(summary, results), "utf8");
  console.log(`[perf] winner=${summary.winner?.name ?? "none"} baseline=${summary.baseline?.name ?? "none"}`);
  console.log(`[perf] report=${path.join(outDir, "report.md")}`);
  app.quit();
}

async function prepareCachedOcrHints(simplePage, baseOptions, samples, pagesDir) {
  const hintsByPath = new Map();
  for (const [index, sample] of samples.entries()) {
    const outputDir = path.join(pagesDir, String(index + 1).padStart(2, "0"), "ocr");
    const options = {
      ...baseOptions,
      imagePath: sample.imagePath,
      imageWidth: sample.width,
      imageHeight: sample.height,
      outputDir,
      label: `perf-ocr-${index + 1}`,
      ocrProgressDefaultToPage: false
    };
    const result = await simplePage.collectOcrBboxHints(options);
    hintsByPath.set(sample.imagePath, result.hints);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "ocr-hints.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`[perf] cached OCR ${index + 1}/${samples.length}: hints=${result.hints.length}`);
  }
  return hintsByPath;
}

async function runCandidate({ candidate, candidateIndex, baseOptions, simplePage, overlayTools, samples, ocrHintsByPath, outDir }) {
  const candidateDir = path.join(outDir, "candidates", candidate.name);
  await mkdir(candidateDir, { recursive: true });
  const options = {
    ...baseOptions,
    port: BASE_PORT + candidateIndex,
    serverLogPath: path.join(candidateDir, "server.log"),
    ctx: candidate.ctx ?? baseOptions.ctx,
    batch: candidate.batch,
    ubatch: candidate.ubatch,
    extraArgs: candidate.extraArgs,
    threads: candidate.threads,
    threadsBatch: candidate.threadsBatch,
    poll: candidate.poll,
    pollBatch: candidate.pollBatch,
    prioBatch: candidate.prioBatch,
    cacheIdleSlots: candidate.cacheIdleSlots,
    cacheReuse: candidate.cacheReuse,
    kvOffload: candidate.kvOffload ?? baseOptions.kvOffload,
    mmprojOffload: candidate.mmprojOffload ?? baseOptions.mmprojOffload,
    cacheTypeK: candidate.cacheTypeK ?? baseOptions.cacheTypeK,
    cacheTypeV: candidate.cacheTypeV ?? baseOptions.cacheTypeV,
    enableMetrics: true,
    enablePerf: true,
    useDraft: false,
    gemmaVramMode: "economy",
    label: `perf-${candidate.name}`
  };
  const launchArgs = simplePage.buildLaunchArgs(options);
  await writeFile(path.join(candidateDir, "launch-args.txt"), `${launchArgs.join(" ")}\n`, "utf8");

  console.log(`[perf] start ${candidate.name}`);
  const beforeStart = readGpuSnapshot(null);
  const server = await simplePage.startServer(options);
  const pid = server.child?.pid ?? null;
  const afterStart = readGpuSnapshot(pid);
  const pages = [];
  try {
    for (let runIndex = 0; runIndex < RUNS_PER_CANDIDATE; runIndex += 1) {
      for (const [sampleIndex, sample] of samples.entries()) {
        const pageDir = path.join(candidateDir, `run-${runIndex + 1}`, `page-${sampleIndex + 1}`);
        await mkdir(pageDir, { recursive: true });
        const pageOptions = {
          ...options,
          imagePath: sample.imagePath,
          imageWidth: sample.width,
          imageHeight: sample.height,
          outputDir: pageDir,
          label: `perf-${candidate.name}-r${runIndex + 1}-p${sampleIndex + 1}`,
          ocrBboxHints: ocrHintsByPath.get(sample.imagePath) ?? []
        };
        const measured = await measureGpuDuring(pid, () => simplePage.requestTranslation(server, pageOptions));
        await simplePage.saveArtifacts(pageOptions, measured.result);
        const parsed = overlayTools.parseJsonLenient(measured.result.outputText);
        const items = overlayTools.normalizeItems(parsed);
        const timings = measured.result.rawResponse?.timings ?? null;
        const pageResult = {
          runIndex,
          sampleIndex,
          imagePath: sample.imagePath,
          wallMs: measured.wallMs,
          blockCount: items.length,
          timings,
          gpu: summarizeGpuSamples(measured.gpuSamples)
        };
        pages.push(pageResult);
        await writeFile(path.join(pageDir, "perf.json"), `${JSON.stringify(pageResult, null, 2)}\n`, "utf8");
        console.log(`[perf] ${candidate.name} r${runIndex + 1} p${sampleIndex + 1}: ${pageResult.wallMs}ms, blocks=${items.length}`);
      }
    }
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
      ...summarizeServerLog(serverLogText)
    },
    beforeStart,
    afterStart,
    afterStop,
    serverPid: pid,
    pages,
    measured: summarizeMeasuredPages(pages, beforeStart)
  };
  await writeFile(path.join(candidateDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function writeFailedCandidateResult({ candidate, candidateIndex, outDir, error }) {
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
      lastCudaMemoryBreakdown: null
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
      maxBlockCount: 0
    },
    error: {
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
      candidateIndex
    }
  };
  await writeFile(path.join(candidateDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.warn(`[perf] ${candidate.name} failed: ${result.error.message}`);
  return result;
}

async function measureGpuDuring(pid, run) {
  const samples = [];
  let sampling = false;
  const timer = setInterval(() => {
    if (sampling) {
      return;
    }
    sampling = true;
    try {
      samples.push(readGpuSnapshot(pid));
    } finally {
      sampling = false;
    }
  }, GPU_SAMPLE_INTERVAL_MS);
  const startedAt = Date.now();
  try {
    const result = await run();
    samples.push(readGpuSnapshot(pid));
    return {
      wallMs: Date.now() - startedAt,
      result,
      gpuSamples: samples
    };
  } finally {
    clearInterval(timer);
  }
}

function summarizeMeasuredPages(pages, beforeStart) {
  const measuredPages = pages.filter((page) => RUNS_PER_CANDIDATE <= 1 || page.runIndex > 0);
  const wallMsValues = measuredPages.map((page) => page.wallMs).filter(Number.isFinite);
  const promptPerSecond = measuredPages.map((page) => Number(page.timings?.prompt_per_second)).filter(Number.isFinite);
  const predictedPerSecond = measuredPages.map((page) => Number(page.timings?.predicted_per_second)).filter(Number.isFinite);
  const peakProcessVramMb = Math.max(0, ...measuredPages.map((page) => Number(page.gpu.peakProcessVramMb)).filter(Number.isFinite));
  const peakGpuUsedMb = Math.max(0, ...measuredPages.map((page) => Number(page.gpu.peakGpuUsedMb)).filter(Number.isFinite));
  const beforeGpuUsedMb = Number(beforeStart?.gpuUsedMb);
  const peakGpuDeltaMb = Number.isFinite(beforeGpuUsedMb) && peakGpuUsedMb > 0 ? Math.max(0, peakGpuUsedMb - beforeGpuUsedMb) : null;
  return {
    measuredPageCount: measuredPages.length,
    meanWallMs: average(wallMsValues),
    meanPromptTokensPerSecond: average(promptPerSecond),
    meanPredictedTokensPerSecond: average(predictedPerSecond),
    peakProcessVramMb: peakProcessVramMb || null,
    peakGpuDeltaMb,
    peakGpuUsedMb: peakGpuUsedMb || null,
    minBlockCount: Math.min(...measuredPages.map((page) => page.blockCount)),
    maxBlockCount: Math.max(...measuredPages.map((page) => page.blockCount))
  };
}

function summarizeResults(results) {
  const baseline = results.find((result) => result.name === "baseline-b1024-ub1024") ?? results[0] ?? null;
  if (!baseline) {
    return { baseline: null, winner: null, accepted: [] };
  }
  const baselineWall = Number(baseline.measured.meanWallMs);
  const baselinePeak = Number(baseline.measured.peakProcessVramMb ?? baseline.measured.peakGpuDeltaMb ?? baseline.measured.peakGpuUsedMb ?? 0);
  const baselineMinBlocks = Number(baseline.measured.minBlockCount);
  const accepted = results.filter((result) => {
    if (result === baseline) {
      return true;
    }
    if (result.serverLog?.imageTokenClipped) {
      return false;
    }
    if (Number.isFinite(baselineMinBlocks) && Number(result.measured.minBlockCount) < baselineMinBlocks) {
      return false;
    }
    const wall = Number(result.measured.meanWallMs);
    const peak = Number(result.measured.peakProcessVramMb ?? result.measured.peakGpuDeltaMb ?? result.measured.peakGpuUsedMb ?? 0);
    if (!Number.isFinite(wall) || !Number.isFinite(baselineWall) || wall <= 0 || baselineWall <= 0) {
      return false;
    }
    if (baselinePeak > 0 && peak > baselinePeak + VRAM_DELTA_LIMIT_MB) {
      return false;
    }
    return wall <= baselineWall * (1 - MIN_WALL_IMPROVEMENT);
  });
  const winner = [...accepted].sort((a, b) => {
    const wallDelta = Number(a.measured.meanWallMs) - Number(b.measured.meanWallMs);
    if (Math.abs(wallDelta) > 500) {
      return wallDelta;
    }
    return Number(a.measured.peakProcessVramMb ?? a.measured.peakGpuDeltaMb ?? a.measured.peakGpuUsedMb ?? 0) -
      Number(b.measured.peakProcessVramMb ?? b.measured.peakGpuDeltaMb ?? b.measured.peakGpuUsedMb ?? 0);
  })[0] ?? baseline;
  return {
    baseline: pickSummary(baseline),
    winner: pickSummary(winner),
    accepted: accepted.map(pickSummary),
    rules: {
      minWallImprovement: MIN_WALL_IMPROVEMENT,
      vramDeltaLimitMb: VRAM_DELTA_LIMIT_MB
    }
  };
}

function pickSummary(result) {
  return {
    name: result.name,
    candidate: result.candidate,
    measured: result.measured
  };
}

function buildMarkdownReport(summary, results) {
  const lines = [
    "# Gemma Economy Performance Benchmark",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Winner: ${summary.winner?.name ?? "none"}`,
    `- Baseline: ${summary.baseline?.name ?? "none"}`,
    `- Rule: >= ${(MIN_WALL_IMPROVEMENT * 100).toFixed(1)}% mean wall improvement, <= +${VRAM_DELTA_LIMIT_MB} MiB peak VRAM`,
    "",
    "| Candidate | Mean wall ms | Prompt tok/s | Decode tok/s | Server self MiB | Context MiB | Compute MiB | Peak process VRAM MiB | Peak GPU delta MiB | Blocks | Flags |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |"
  ];
  for (const result of results) {
    const measured = result.measured;
    const memory = result.serverLog?.lastCudaMemoryBreakdown;
    lines.push([
      result.name,
      formatNumber(measured.meanWallMs, 0),
      formatNumber(measured.meanPromptTokensPerSecond, 2),
      formatNumber(measured.meanPredictedTokensPerSecond, 2),
      memory?.selfMiB ?? "",
      memory?.contextMiB ?? "",
      memory?.computeMiB ?? "",
      measured.peakProcessVramMb ?? "",
      measured.peakGpuDeltaMb ?? "",
      `${measured.minBlockCount}-${measured.maxBlockCount}`,
      buildResultFlags(result, summary.baseline)
    ].join(" | "));
  }
  lines.push("");
  lines.push("## Launch Args");
  for (const result of results) {
    lines.push("");
    lines.push(`### ${result.name}`);
    lines.push("```text");
    lines.push(JSON.stringify(result.candidate));
    lines.push("```");
  }
  return `${lines.join("\n")}\n`;
}

function buildResultFlags(result, baselineSummary) {
  const flags = [];
  if (result.serverLog?.imageTokenClipped) {
    flags.push("image-token-clipped");
  }
  const baselineMinBlocks = Number(baselineSummary?.measured?.minBlockCount);
  if (Number.isFinite(baselineMinBlocks) && Number(result.measured?.minBlockCount) < baselineMinBlocks) {
    flags.push("block-count-regression");
  }
  if (result.failed) {
    flags.push("failed");
  }
  return flags.join(", ");
}

function summarizeGpuSamples(samples) {
  const gpuUtils = samples.map((sample) => sample.gpuUtilPercent).filter(Number.isFinite);
  const processVram = samples.map((sample) => sample.processVramMb).filter(Number.isFinite);
  const gpuUsed = samples.map((sample) => sample.gpuUsedMb).filter(Number.isFinite);
  return {
    sampleCount: samples.length,
    avgGpuUtilPercent: average(gpuUtils),
    peakGpuUtilPercent: maxOrNull(gpuUtils),
    peakProcessVramMb: maxOrNull(processVram),
    peakGpuUsedMb: maxOrNull(gpuUsed)
  };
}

function readGpuSnapshot(pid) {
  const gpu = readGpuUtilAndMemory();
  return {
    ...gpu,
    processVramMb: pid ? readProcessVramMb(pid) : null,
    timestamp: new Date().toISOString()
  };
}

function readGpuUtilAndMemory() {
  try {
    const stdout = execFileSync("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      windowsHide: true
    }).trim();
    const [util, used] = stdout.split(/\s*,\s*/);
    return {
      gpuUtilPercent: Number(util),
      gpuUsedMb: Number(used)
    };
  } catch {
    return {
      gpuUtilPercent: null,
      gpuUsedMb: null
    };
  }
}

function readProcessVramMb(pid) {
  try {
    const stdout = execFileSync("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      windowsHide: true
    }).trim();
    for (const line of stdout.split(/\r?\n/)) {
      const [linePid, used] = line.split(/\s*,\s*/);
      if (Number(linePid) === Number(pid)) {
        const value = Number(String(used).replace(/[^\d.]/g, ""));
        return Number.isFinite(value) ? value : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function createPageRecord(imagePath, index) {
  const image = nativeImage.createFromPath(imagePath);
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`Failed to read image dimensions: ${imagePath}`);
  }
  return {
    id: `perf-page-${index + 1}`,
    name: path.basename(imagePath),
    imagePath,
    width: size.width,
    height: size.height
  };
}

function resolveSamples() {
  const configured = String(process.env.MANGA_PERF_SAMPLE_PATHS || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const limit = readIntEnv("MANGA_PERF_SAMPLE_LIMIT", configured.length || DEFAULT_SAMPLE_PATHS.length);
  return (configured.length > 0 ? configured : DEFAULT_SAMPLE_PATHS).filter((item) => existsSync(item)).slice(0, limit);
}

function candidateKeepsImageTokenBudget(candidate, baseOptions) {
  const requiredBatch = Math.max(Number(baseOptions.imageMinTokens) || 0, Number(baseOptions.imageMaxTokens) || 0);
  const batch = Number(candidate.batch) || 0;
  if (requiredBatch > 0 && batch < requiredBatch) {
    console.warn(
      `[perf] skip ${candidate.name}: batch=${candidate.batch} would clip image token budget ${requiredBatch}`
    );
    return false;
  }
  if (requiredBatch > 0 && Number(candidate.ubatch) > 0 && Number(candidate.ubatch) < requiredBatch) {
    console.warn(`[perf] allow ${candidate.name}: ubatch=${candidate.ubatch} is below image token budget; output will be checked for clipping`);
  }
  return true;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function summarizeServerLog(text) {
  const logText = String(text ?? "");
  const imageTokenClipped = /clip_set_limit_image_tokens|limiting image_(?:min|max)_tokens/i.test(logText);
  const memoryBreakdowns = [...logText.matchAll(
    /\|\s+- CUDA0.*?\|\s+\d+\s*=\s*\d+\s*\+\s*\(\s*(\d+)\s*=\s*(\d+)\s*\+\s*(\d+)\s*\+\s*(\d+)\s*\)/g
  )].map((match) => ({
    selfMiB: Number(match[1]),
    modelMiB: Number(match[2]),
    contextMiB: Number(match[3]),
    computeMiB: Number(match[4])
  }));
  return {
    imageTokenClipped,
    lastCudaMemoryBreakdown: memoryBreakdowns.at(-1) ?? null
  };
}

function average(values) {
  const filtered = values.filter(Number.isFinite);
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function maxOrNull(values) {
  const filtered = values.filter(Number.isFinite);
  return filtered.length > 0 ? Math.max(...filtered) : null;
}

function formatNumber(value, digits) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "";
}

function readIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
