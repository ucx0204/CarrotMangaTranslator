/**
 * @typedef {{ [key: string]: unknown }} BenchmarkOptions
 * @typedef {{ buildLaunchArgs(options: BenchmarkOptions): string[]; collectOcrBboxHints(options: BenchmarkOptions): Promise<{ hints: unknown[] }>; requestTranslation(server: unknown, options: BenchmarkOptions): Promise<any>; saveArtifacts(options: BenchmarkOptions, result: any): Promise<void>; startServer(options: BenchmarkOptions): Promise<any>; stopServer(server: any): Promise<void> }} SimplePageModule
 * @typedef {{ parseJsonLenient(rawText: string): unknown; normalizeItems(parsed: unknown): unknown[] }} OverlayToolsModule
 * @typedef {any} BenchmarkResult
 */
const { app } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  CANDIDATES,
  CANDIDATE_FILTER,
  MIN_WALL_IMPROVEMENT,
  ROOT,
  RUNS_PER_CANDIDATE,
  SKIP_OCR,
  VRAM_DELTA_LIMIT_MB,
} = require("./config.cjs");
const { prepareCachedOcrHints } = require("./ocr-cache.cjs");
const {
  runCandidate,
  writeFailedCandidateResult,
} = require("./candidate-runner.cjs");
const { createBenchmarkReporting } = require("./reporting.cjs");
const {
  candidateKeepsImageTokenBudget,
  createPageRecord,
  readJsonIfExists,
  resolveSamples,
} = require("./samples.cjs");
const { buildMarkdownReport, summarizeResults } = createBenchmarkReporting({
  minWallImprovement: MIN_WALL_IMPROVEMENT,
  vramDeltaLimitMb: VRAM_DELTA_LIMIT_MB,
});

/**
 * @returns {Promise<void>}
 */
async function main() {
  app.setPath(
    "userData",
    path.join(ROOT, ".tmp", "perf-gemma-economy", "electron-user-data"),
  );
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disk-cache-size", "0");
  app.on("window-all-closed", () => {});
  await app.whenReady();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(ROOT, ".tmp", "perf-gemma-economy", timestamp);
  const pagesDir = path.join(outDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  const { getAppPaths } =
    /** @type {typeof import("../../src/main/appPaths")} */ (
      loadBuiltModule("out/main/appPaths.js")
    );
  const { normalizeAppSettings, buildBaseTranslationOptions } =
    /** @type {typeof import("../../src/main/appSettings")} */ (
      loadBuiltModule("out/main/appSettings.js")
    );
  const simplePage = /** @type {SimplePageModule} */ (
    loadBuiltModule("out/app-runtime/simple-page-translate.cjs")
  );
  const overlayTools = /** @type {OverlayToolsModule} */ (
    loadBuiltModule("out/app-runtime/overlay-parser.cjs")
  );

  const paths = getAppPaths();
  const settings = normalizeAppSettings(
    await readJsonIfExists(paths.settingsPath),
  );
  settings.modelProvider = "gemma";
  settings.gemma.vramMode = "economy26b";

  const baseOptions = buildBaseTranslationOptions({
    jobId: "perf-gemma-economy",
    runDir: path.join(outDir, "runs"),
    paths,
    settings,
  });

  const samples = resolveSamples().map((imagePath, index) =>
    createPageRecord(imagePath, index),
  );
  const candidates = (
    CANDIDATE_FILTER.length > 0
      ? CANDIDATES.filter((candidate) =>
          CANDIDATE_FILTER.includes(candidate.name),
        )
      : CANDIDATES
  ).filter((candidate) =>
    candidateKeepsImageTokenBudget(candidate, baseOptions),
  );
  if (samples.length === 0) {
    throw new Error("No benchmark sample images found.");
  }
  if (candidates.length === 0) {
    throw new Error(
      `No benchmark candidates matched: ${CANDIDATE_FILTER.join(", ")}`,
    );
  }
  await writeFile(
    path.join(outDir, "samples.json"),
    `${JSON.stringify(samples, null, 2)}\n`,
    "utf8",
  );

  console.log(`[perf] writing ${outDir}`);
  console.log(
    `[perf] samples=${samples.length}, candidates=${candidates.length}, runs=${RUNS_PER_CANDIDATE}`,
  );

  const ocrHintsByPath = SKIP_OCR
    ? new Map()
    : await prepareCachedOcrHints(simplePage, baseOptions, samples, pagesDir);
  /** @type {BenchmarkResult[]} */
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
        outDir,
      });
    } catch (error) {
      candidateResult = await writeFailedCandidateResult({
        candidate,
        candidateIndex,
        outDir,
        error,
      });
    }
    results.push(candidateResult);
    await writeFile(
      path.join(outDir, "results.partial.json"),
      `${JSON.stringify(results, null, 2)}\n`,
      "utf8",
    );
  }

  const summary = summarizeResults(results);
  await writeFile(
    path.join(outDir, "results.json"),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outDir, "report.md"),
    buildMarkdownReport(summary, results),
    "utf8",
  );
  console.log(
    `[perf] winner=${summary.winner?.name ?? "none"} baseline=${summary.baseline?.name ?? "none"}`,
  );
  console.log(`[perf] report=${path.join(outDir, "report.md")}`);
  app.quit();
}

/**
 * @param {string} relativePath
 * @returns {unknown}
 */
function loadBuiltModule(relativePath) {
  return require(path.join(ROOT, relativePath));
}

module.exports = { main };
