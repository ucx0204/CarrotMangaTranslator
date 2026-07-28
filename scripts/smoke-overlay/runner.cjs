const { app } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { applySmokeOptionOverrides } = require("./options.cjs");
const { createPageRunner } = require("./page-runner.cjs");
const { createSmokeRenderer } = require("./rendering.cjs");
const { writeReport } = require("./report.cjs");
const { selectSmokeSamples } = require("./sample-selector.cjs");
const { readJsonIfExists } = require("./utils.cjs");

/**
 * @typedef {{ root: string; mangaRoot: string; sampleCount: number; sampleOffset: number; targetImagePath: string; targetImageList: string; targetImageListFile: string; smokeProvider: "" | "gemma" | "openai-codex"; reuseOcrDir: string; maxCaptureLongSide: number; pageTimeoutMs: number }} RunnerConfig
 */

/** @param {RunnerConfig} config */
async function runSmokeOverlay(config) {
  await prepareElectron(config.root);
  const context = await prepareRun(config);
  const startedAt = Date.now();
  const server = await startTranslationServer(context);
  let outcome;
  try {
    outcome = await context.pageRunner.runCandidates({
      samples: context.samples,
      pagesDir: context.pagesDir,
      sampleCount: config.sampleCount,
      server,
    });
  } finally {
    await stopTranslationServer(context, server);
  }
  await finalizeRun(context, outcome, Date.now() - startedAt);
  console.log(`[smoke] wrote ${context.outDir}`);
  app.quit();
}

/** @param {string} root */
async function prepareElectron(root) {
  app.setPath(
    "userData",
    path.join(root, ".tmp", "smoke-overlay", "electron-user-data"),
  );
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disk-cache-size", "0");
  app.on("window-all-closed", () => {});
  await app.whenReady();
}

/** @param {RunnerConfig} config */
async function prepareRun(config) {
  const modules = loadRuntimeModules(config.root);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(config.root, ".tmp", "smoke-overlay", timestamp);
  const pagesDir = path.join(outDir, "pages");
  await mkdir(pagesDir, { recursive: true });
  const baseOptions = await buildOptions(modules, config, outDir);
  const samples = await loadSamples(config, outDir);
  await writeSettingsSummary(outDir, baseOptions, config.reuseOcrDir);
  const renderer = createSmokeRenderer({
    maxCaptureLongSide: config.maxCaptureLongSide,
    getSharedGeometry: () => modules.sharedGeometry,
  });
  const pageRunner = createPageRunner({
    baseOptions,
    pageTimeoutMs: config.pageTimeoutMs,
    reuseOcrDir: config.reuseOcrDir,
    simplePage: modules.simplePage,
    overlayTools: modules.overlayTools,
    ...modules.pipeline,
    ...renderer,
  });
  return {
    ...modules,
    ...renderer,
    baseOptions,
    samples,
    outDir,
    pagesDir,
    pageRunner,
    sampleCount: config.sampleCount,
  };
}

/** @param {string} root */
function loadRuntimeModules(root) {
  /** @param {string} relativePath */
  const load = (relativePath) => require(path.join(root, relativePath));
  const overlayItems = load("out/main/pipeline/overlayItems.js");
  const overlayItemReferences = load(
    "out/main/pipeline/overlayItemReferences.js",
  );
  const overlayOcrGeometryLocks = load(
    "out/main/pipeline/overlayOcrGeometryLocks.js",
  );
  return {
    getAppPaths: load("out/main/appPaths.js").getAppPaths,
    appSettings: load("out/main/appSettings.js"),
    oauth: load("out/main/openaiOauthEndpoint.js"),
    pipeline: {
      applyOcrCandidateGeometryLocks:
        overlayOcrGeometryLocks.applyOcrCandidateGeometryLocks,
      filterRejectedOrUncertainSoundItems:
        overlayItems.filterRejectedOrUncertainSoundItems,
      getPipelineBboxNormalizationOptions:
        overlayItemReferences.getBboxNormalizationOptions,
      getOcrBboxHints: overlayItemReferences.getOcrBboxHints,
      normalizeOverlayItemBboxes:
        overlayItemReferences.normalizeOverlayItemBboxes,
      overlayItemToBlock: overlayItems.overlayItemToBlock,
    },
    sharedGeometry: load("out/shared/geometry.js"),
    simplePage: load("out/app-runtime/simple-page-translate.cjs"),
    overlayTools: load("out/app-runtime/overlay-parser.cjs"),
  };
}

/** @param {ReturnType<typeof loadRuntimeModules>} modules @param {RunnerConfig} config @param {string} outDir */
async function buildOptions(modules, config, outDir) {
  const paths = modules.getAppPaths();
  const settings = modules.appSettings.normalizeAppSettings(
    await readJsonIfExists(paths.settingsPath),
  );
  const configured = modules.appSettings.buildBaseTranslationOptions({
    jobId: "smoke-overlay",
    runDir: path.join(outDir, "runs"),
    paths,
    settings,
  });
  return applySmokeOptionOverrides({
    ...configured,
    ...(config.smokeProvider ? { modelProvider: config.smokeProvider } : {}),
    serverLogPath: path.join(outDir, "server.log"),
    label: "smoke-overlay",
  });
}

/** @param {RunnerConfig} config @param {string} outDir */
async function loadSamples(config, outDir) {
  const samples = await selectSmokeSamples({
    root: config.mangaRoot,
    count: config.sampleCount * 4,
    targetImagePath: config.targetImagePath,
    targetImageList: config.targetImageList,
    targetImageListFile: config.targetImageListFile,
    sampleOffset: config.sampleOffset,
  });
  await writeFile(
    path.join(outDir, "samples.json"),
    `${JSON.stringify(samples, null, 2)}\n`,
    "utf8",
  );
  return samples;
}

/** @param {string} outDir @param {Record<string, any>} options @param {string} reuseOcrDir */
async function writeSettingsSummary(outDir, options, reuseOcrDir) {
  const keys = [
    "modelProvider",
    "gemmaVramMode",
    "modelRepo",
    "modelFile",
    "mmprojRepo",
    "mmprojFile",
    "ctx",
    "batch",
    "ubatch",
    "kvOffload",
    "mmprojOffload",
    "fitTargetMb",
    "useDraft",
    "imageMinTokens",
    "imageMaxTokens",
    "codexModel",
    "codexReasoningEffort",
  ];
  const summary = Object.fromEntries(keys.map((key) => [key, options[key]]));
  summary.reuseOcrDir = reuseOcrDir || undefined;
  await writeFile(
    path.join(outDir, "settings-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
}

/** @param {Awaited<ReturnType<typeof prepareRun>>} context */
async function startTranslationServer(context) {
  return context.baseOptions.modelProvider === "openai-codex"
    ? context.oauth.startOpenAIOAuthEndpoint(context.baseOptions)
    : context.simplePage.startServer(context.baseOptions);
}

/** @param {Awaited<ReturnType<typeof prepareRun>>} context @param {unknown} server */
async function stopTranslationServer(context, server) {
  if (context.baseOptions.modelProvider === "openai-codex") {
    await context.oauth.stopOpenAIOAuthEndpoint(server);
  } else {
    await context.simplePage.stopServer(server);
  }
}

/** @param {Awaited<ReturnType<typeof prepareRun>>} context @param {{ rendered: any[]; skipped: any[] }} outcome @param {number} elapsedMs */
async function finalizeRun(context, outcome, elapsedMs) {
  await writeFile(
    path.join(context.outDir, "skipped.json"),
    `${JSON.stringify(outcome.skipped, null, 2)}\n`,
    "utf8",
  );
  const shouldWriteSheets =
    context.sampleCount > 1 || outcome.rendered.length > 1;
  const geometrySheetPath = shouldWriteSheets
    ? path.join(context.outDir, "geometry-sheet.png")
    : "";
  const overlaySheetPath = shouldWriteSheets
    ? path.join(context.outDir, "overlay-sheet.png")
    : "";
  if (shouldWriteSheets) {
    await context.renderContactSheet(
      outcome.rendered,
      geometrySheetPath,
      "geometryPath",
    );
    await context.renderContactSheet(
      outcome.rendered,
      overlaySheetPath,
      "overlayPath",
    );
  }
  await writeReport(
    context.outDir,
    outcome.rendered,
    outcome.skipped,
    geometrySheetPath,
    overlaySheetPath,
    context.baseOptions,
    elapsedMs,
  );
}

module.exports = { runSmokeOverlay };
