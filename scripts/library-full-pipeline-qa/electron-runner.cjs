/* eslint-disable @typescript-eslint/ban-ts-comment -- this isolated QA bridge integrates runtime-defined production contracts */
// @ts-nocheck -- this isolated runner bridges several compiled production modules with runtime-defined contracts.
/* eslint-disable max-lines -- the isolated Electron harness keeps its production-stage orchestration auditable in one entrypoint */
const { app } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { promisify } = require("node:util");
const {
  createFontReplayPageDecisionContext,
  resolveFontReplayImagePath,
  resolveFontReplayInputPath,
  restoreFontReplaySemanticRole,
} = require("./font-replay-cache.cjs");
const {
  CACHE_VALIDATION_VERSION,
  resolveFontReplayInferencePath,
  restoreCachedFontInference,
} = require("./font-replay-inference-cache.cjs");
const { buildFontDecisionLog } = require("./font-decision-log.cjs");
const {
  QA_PAGE_COMPLETION_CONTRACT_VERSION,
  assertQaInpaintingResultMatchesProduction,
  isQaRunExactlyCompleted,
  isQaTargetlessPage,
  resolveQaPageCompletion,
  seedQaTranslationCompletion,
} = require("./page-completion-contract.cjs");
const {
  summarizePageRelativeRoleQa,
} = require("./page-relative-role-qa-audit.cjs");
const {
  attachFontReplaySourceGeometryDirections,
  loadFontReplayBaselineSeal,
  summarizeSourceGeometryDirectionReplay,
} = require("./source-geometry-direction-replay.cjs");

const execFileAsync = promisify(execFile);

const config = readConfig();
const imageProtocol = require(
  path.join(config.root, "out/main/imageProtocol.js"),
);
// Built-in renderer fonts are served through mgt-font://. Electron requires a
// privileged scheme to be declared before app readiness, matching the normal
// application bootstrap order.
imageProtocol.registerImageProtocolScheme();
app.setPath("userData", path.join(config.runDir, "electron-user-data"));
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disk-cache-size", "0");
app.on("window-all-closed", () => {});

run().catch(async (error) => {
  console.error(error?.stack || error);
  try {
    await writeJson(path.join(config.runDir, "fatal-error.json"), {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } catch (_writeError) {
    // error-policy-allow: preserve the original fatal error.
  }
  process.exitCode = 1;
  app.exit(1);
});

async function run() {
  await fsp.mkdir(path.dirname(config.runDir), { recursive: true });
  // Electron may create the configured nested userData parent before ready.
  // The Node launcher already rejects a pre-existing run directory.
  await fsp.mkdir(config.runDir, { recursive: true });
  await app.whenReady();
  imageProtocol.registerImageProtocolHandler();
  const modules = loadModules(config.root);
  const cohortRecords = await readJsonl(config.manifestPath);
  const records =
    config.selectionIndex === null || config.selectionIndex === undefined
      ? cohortRecords.slice(0, config.pageLimit || undefined)
      : cohortRecords.filter(
          (record) => record.selectionIndex === config.selectionIndex,
        );
  if (
    config.selectionIndex !== null &&
    config.selectionIndex !== undefined &&
    records.length !== 1
  ) {
    throw new Error(
      `Frozen cohort selection index ${config.selectionIndex} matched ${records.length} pages; expected exactly one.`,
    );
  }
  assertCohort(records);
  const context = await createRuntimeContext(modules);
  const report = createInitialReport(records, context);
  await writeJson(
    path.join(config.runDir, "run-config.json"),
    redactConfig(context),
  );
  try {
    if (config.preflightOnly) {
      report.runtimePreflight = await runRuntimePreflight(modules, context);
      report.status =
        report.runtimePreflight.state === "ready"
          ? "preflight-completed"
          : "preflight-failed";
    } else if (config.cacheFrom) {
      await runFontReplay(records, modules, context, report);
    } else {
      await runFullPipeline(records, modules, context, report);
    }
    if (!config.preflightOnly) {
      report.status = isQaRunExactlyCompleted(
        report.pages,
        records.map((record) => record.page.id),
      )
        ? "completed"
        : "partial";
      if (report.status !== "completed") process.exitCode = 1;
    }
  } catch (error) {
    report.status = "failed";
    report.fatalError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await context.releaseTranslationEndpoint();
    context.inpaintingLease?.release();
    context.exportSession?.close();
    report.finishedAt = new Date().toISOString();
    await persistReport(report);
    await writeReviewHtml(report);
  }
  console.log(`[font-qa] ${report.status}: ${config.runDir}`);
  if (config.preflightOnly && report.runtimePreflight?.state !== "ready") {
    process.exitCode = 1;
  }
  app.exit(process.exitCode || 0);
}

/** @param {string} root */
function loadModules(root) {
  /** @param {string} relative */
  const load = (relative) => require(path.join(root, relative));
  return {
    automaticFont: load("out/main/pipeline/automaticFontMatchingV2.js"),
    automaticFontApply: load(
      "out/main/pipeline/automaticFontMatchingV2Apply.js",
    ),
    automaticFontCoordinator: load(
      "out/main/pipeline/automaticFontMatchingV2PageCoordinator.js",
    ),
    blockFormat: load("out/shared/blockFormat.js"),
    activeCatalog: load("out/main/pipeline/autoMatchActiveCatalog.js"),
    appPaths: load("out/main/appPaths.js"),
    bubbleFacade: load("out/main/bubbleLayout/bubbleLayoutFacade.js"),
    bubbleLayoutJob: load("out/main/jobs/bubbleLayoutJob.js"),
    bubbleRunner: load("out/main/inpainting/bubbleLayoutRunner.js"),
    builtInCatalog: load("out/main/builtInFontMatchingCatalog.js"),
    fontImage: load("out/main/fontMatchingPageImage.js"),
    fontGeometryDirection: load(
      "out/main/pipeline/fontMatchingOcrGeometryDirection.js",
    ),
    fontInference: load("out/main/pipeline/fontMatchingPagePixelInference.js"),
    inpainting: load("out/main/inpainting/patternPage.js"),
    inpaintingCompletion: load("out/main/jobs/inpaintingJobPageCompletion.js"),
    inpaintingLayout: load("out/main/inpainting/inpaintingLayoutState.js"),
    inpaintingPool: load("out/main/inpainting/inpaintingEnginePool.js"),
    library: load("out/main/library.js"),
    pageExport: load("out/main/pageExport.js"),
    pipelinePorts: load("out/main/pipeline/wholePagePipelinePorts.js"),
    retiredFonts: load(
      "out/main/pipeline/automaticFontMatchingRetiredFonts.js",
    ),
    textOutline: load("out/shared/textOutline.js"),
    settings: load("out/main/settingsStore.js"),
    wholePipeline: load("out/main/wholePagePipeline.js"),
  };
}

/** @param {ReturnType<typeof loadModules>} modules */
async function createRuntimeContext(modules) {
  const appPaths = modules.appPaths.getAppPaths();
  const appSettings = await modules.settings.getAppSettings(appPaths);
  assertProviderSafety(appSettings);
  const defaultDependencies =
    modules.pipelinePorts.createDefaultWholePagePipelineDependencies();
  const builtIn = modules.builtInCatalog.loadBuiltInFontMatchingCandidates(
    "ko",
    (message) => console.warn(`[font-qa] ${message}`),
  );
  const selection = modules.activeCatalog.loadAutoMatchActiveCandidateSelection(
    {
      activeCatalogPath: path.join(
        config.runtimeDir,
        "auto-match-active-catalog.json",
      ),
      assetRoots: modules.builtInCatalog.resolveBuiltInFontMatchingAssetRoots(),
      builtInCandidates: builtIn,
      targetLocale: "ko",
    },
  );
  const loadSelection = (locale) => {
    if (locale !== "ko") throw new Error("Font QA runtime is Korean-only.");
    return selection;
  };
  const baseInference =
    modules.fontInference.createFontMatchingPageInferencePort({
      artifactDir: config.runtimeDir,
      allowQaOnlyRuntime: config.allowQaOnlyRuntime === true,
      loadSelection,
      resolveWasmAssets: () =>
        modules.fontInference.resolveFontMatchingOrtWasmAssets(appPaths),
      loadRaster: modules.fontImage.loadFontMatchingPageRaster,
      reportWarning: (message, detail) =>
        console.warn(`[font-qa] ${message}`, detail),
    });
  const inferenceTraces = new Map();
  const pageInference = {
    async inferPage(request) {
      const startedAt = Date.now();
      const qaRequest =
        config.qaPageRelativeRoleReroute === true
          ? { ...request, qaPageRelativeRoleReroute: true }
          : request;
      const result = await baseInference.inferPage(qaRequest);
      inferenceTraces.set(request.page.id, {
        elapsedMs: Date.now() - startedAt,
        qaPageRelativeRoleReroute: config.qaPageRelativeRoleReroute === true,
        requestBlocks: request.blocks.map((entry) => ({
          blockId: entry.blockId,
          item: entry.item,
          ...(entry.sourceGeometryDirection
            ? { sourceGeometryDirection: entry.sourceGeometryDirection }
            : {}),
        })),
        runtimeArtifactStatus: result.runtimeArtifactStatus,
        pixelInference: [...result.pixelInferenceByBlockId.entries()].map(
          ([blockId, inference]) => ({ blockId, ...inference }),
        ),
      });
      return result;
    },
  };
  const sharedRuntime = createSharedEndpointRuntime(
    defaultDependencies.runtime,
  );
  const dependencies = {
    ...defaultDependencies,
    runtime: sharedRuntime.runtime,
    fontMatching: {
      ...defaultDependencies.fontMatching,
      loadCandidates: (targetLanguage) =>
        targetLanguage === "ko" ? selection.candidates : [],
      pageInference,
    },
    pageContext: {
      // QA must never change a work's stored style guide or story memory.
      saveChapterStoryMemory: async (memory) => memory,
      saveWorkStyleGuide: async (guide) => guide,
    },
  };
  return {
    activeCatalog: selection.activeCatalog,
    appPaths,
    appSettings,
    candidates: selection.candidates,
    installedCandidates: selection.installedCandidates,
    dependencies,
    inferenceTraces,
    pageInference,
    releaseTranslationEndpoint: sharedRuntime.release,
    inpaintingLease: null,
    exportSession: null,
  };
}

/** @param {any} runtime */
function createSharedEndpointRuntime(runtime) {
  let sharedPromise = null;
  let sharedSession = null;
  return {
    runtime: {
      ...runtime,
      async startEndpointSession(options) {
        sharedPromise ??= runtime.startEndpointSession(options);
        sharedSession = await sharedPromise;
        return { handle: sharedSession.handle, dispose: async () => {} };
      },
    },
    async release() {
      if (!sharedPromise) return;
      try {
        const session = sharedSession || (await sharedPromise);
        await session.dispose();
      } finally {
        sharedPromise = null;
        sharedSession = null;
      }
    },
  };
}

/** @param {any} settings */
function assertProviderSafety(settings) {
  const provider = String(settings.modelProvider || "");
  if (
    (provider === "openai-api" || provider === "openai-codex") &&
    !config.allowPaidProvider &&
    !config.preflightOnly
  ) {
    throw new Error(
      `Configured provider ${provider} is remote. Re-run with --allow-paid-provider only after explicitly accepting remote calls/cost.`,
    );
  }
  if (settings.translation?.targetLanguage !== "ko") {
    throw new Error(
      "Full-pipeline font QA requires Korean as the target language.",
    );
  }
}

/** @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
async function runRuntimePreflight(modules, context) {
  const loaded = await modules.fontInference.loadFontMatchingRuntimeModel({
    artifactDir: config.runtimeDir,
    allowQaOnlyRuntime: config.allowQaOnlyRuntime === true,
    installedCandidates: context.installedCandidates,
    wasmAssets: await modules.fontInference.resolveFontMatchingOrtWasmAssets(
      context.appPaths,
    ),
  });
  return {
    state: loaded.status.state,
    status: loaded.status,
    modelLoaded: Boolean(loaded.model),
    provider: context.appSettings.modelProvider,
    remoteExecutionWouldRequireApproval:
      context.appSettings.modelProvider === "openai-api" ||
      context.appSettings.modelProvider === "openai-codex",
  };
}

/** @param {any[]} records @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context @param {ReturnType<typeof createInitialReport>} report */
async function runFullPipeline(records, modules, context, report) {
  const groups = groupByChapter(records);
  const translatedByPageId = new Map();
  for (const [groupIndex, group] of groups.entries()) {
    console.log(
      `[font-qa] translate chapter ${groupIndex + 1}/${groups.length}: ${group[0].work.title} / ${group[0].chapter.title}`,
    );
    const workContext = await modules.library.resolveWorkContextForChapter(
      group[0].chapter.id,
    );
    const stagedPages = [];
    for (const record of group) {
      stagedPages.push(await stageFreshPage(record));
    }
    const chapterStage = path.join(
      config.runDir,
      "analysis",
      group[0].chapter.id,
    );
    await fsp.mkdir(chapterStage, { recursive: true });
    const jobId = `font-qa-${group[0].chapter.id}`;
    const canonical = new Map(
      group.map((record) => [record.page.id, record.page.index]),
    );
    try {
      await modules.wholePipeline.runWholePagePipeline(
        {
          jobId,
          pages: stagedPages,
          runPaths: {
            chapterDir: chapterStage,
            runDir: path.join(chapterStage, "run"),
          },
          emit: (event) => logProgress(event),
          signal: new AbortController().signal,
          skipOcrPrepass: false,
          blockMode: "auto",
          workContext: {
            ...workContext,
            chapterId: group[0].chapter.id,
            recentPageCount: 6,
          },
          writeStoryMemory: false,
          collectPageContext: false,
          naturalTextLayout: true,
          autoFontMatching: true,
          canonicalPageIndexById: canonical,
          onPageComplete: async (page) => {
            translatedByPageId.set(page.id, seedQaTranslationCompletion(page));
            return true;
          },
          onPagesComplete: async (pages) => {
            for (const page of pages) {
              translatedByPageId.set(
                page.id,
                seedQaTranslationCompletion(page),
              );
            }
            return new Set(pages.map((page) => page.id));
          },
          onPageFailed: async (page, message) => {
            upsertPageReport(
              report,
              group.find((item) => item.page.id === page.id),
              {
                status: "failed",
                stage: "translation",
                error: message,
              },
            );
          },
        },
        context.dependencies,
      );
    } catch (error) {
      for (const record of group) {
        if (!translatedByPageId.has(record.page.id)) {
          upsertPageReport(report, record, {
            status: "failed",
            stage: "translation",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  await context.releaseTranslationEndpoint();
  const translated = records.filter((record) =>
    translatedByPageId.has(record.page.id),
  );
  if (translated.length > 0) await prepareInpainting(modules, context);
  for (const [pageIndex, record] of records.entries()) {
    const translatedPage = translatedByPageId.get(record.page.id);
    if (!translatedPage) continue;
    console.log(
      `[font-qa] finish ${pageIndex + 1}/${records.length}: ${record.page.name}`,
    );
    try {
      const trace = context.inferenceTraces.get(record.page.id);
      const neutralPage = buildFontReplayInput(
        translatedPage,
        context.appSettings.blockFormatDefaults,
        modules.blockFormat,
      );
      const fontInputPath = await persistFontInput(record, neutralPage, trace);
      const processedPage = await inpaintLayoutAndRender(
        record,
        translatedPage,
        modules,
        context,
      );
      const pageReport = await buildCompletedPageReport(
        record,
        processedPage,
        trace,
        fontInputPath,
        "full",
        modules,
      );
      upsertPageReport(report, record, pageReport);
    } catch (error) {
      upsertPageReport(report, record, {
        status: "failed",
        stage: "inpainting-layout-render",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await persistReport(report);
  }
}

/** @param {any[]} records @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context @param {ReturnType<typeof createInitialReport>} report */
async function runFontReplay(records, modules, context, report) {
  const { baselineSeal, sourcePages } = await loadFontReplaySource(records);
  const inferenceCache = await prepareFontInferenceCacheRuntime(
    modules,
    context,
  );
  const profiles = new Map();
  const coordinators = new Map();
  const replayed = [];
  const reusedInferencePageIds = [];
  const liveInferencePageIds = [];
  for (const [pageIndex, record] of records.entries()) {
    console.log(
      `[font-qa] font replay ${pageIndex + 1}/${records.length}: ${record.page.name}`,
    );
    try {
      const cached = sourcePages.get(record.page.id);
      if (!cached) {
        throw new Error(
          "Cached run has no reusable translation/inpainting assets.",
        );
      }
      const fontInputPath = resolveFontReplayInputPath(
        config.cacheFrom,
        record,
        cached,
      );
      const fontInput = JSON.parse(await fsp.readFile(fontInputPath, "utf8"));
      assertCachedInput(record, fontInput);
      const replayImagePath = resolveFontReplayImagePath(
        record,
        cached,
        fontInput,
      );
      const neutralPage = completeTargetlessFontReplayPage(
        {
          ...fontInput.page,
          imagePath: record.page.imagePath,
          inpaintedImagePath: replayImagePath,
          translationCompletion:
            cached.productionTranslationCompletion ??
            fontInput.page.translationCompletion,
        },
        modules,
      );
      let profile = profiles.get(record.work.id);
      if (profile === undefined) {
        profile = await context.dependencies.fontMatching.loadProfile(
          record.work.id,
        );
        profiles.set(record.work.id, profile || null);
      }
      let coordinator = coordinators.get(record.chapter.id);
      if (!coordinator) {
        coordinator =
          modules.automaticFontCoordinator.createAutomaticFontChapterCoordinatorV2();
        coordinators.set(record.chapter.id, coordinator);
      }
      const inference = await resolveFontReplayPageInference({
        cached,
        context,
        fontInput,
        fontInputPath,
        inferenceCache,
        modules,
        neutralPage,
        record,
        baselineSeal,
      });
      const inferred = inference.result;
      if (inference.source === "cached") {
        reusedInferencePageIds.push(record.page.id);
      } else {
        liveInferencePageIds.push(record.page.id);
      }
      const candidatePage = applyReplayedFontDecisions(
        neutralPage,
        fontInput.requestBlocks,
        inferred,
        record,
        profile || null,
        coordinator,
        modules,
        context.candidates,
      );
      const laidOut = await applyFontReplayLayout(
        candidatePage,
        modules,
        context,
      );
      const renderedImagePath = await renderPage(
        record,
        laidOut,
        modules,
        context,
      );
      const trace = context.inferenceTraces.get(record.page.id);
      if (trace) {
        await writeJson(
          path.join(pageOutputDir(record), "font-inference.json"),
          trace,
        );
      }
      const pageReport = await buildCompletedPageReport(
        record,
        {
          ...laidOut,
          renderedImagePath,
          qaCleanedImagePath: replayImagePath,
          qaCleanedAssetKind: isQaTargetlessPage(laidOut)
            ? "targetless-original"
            : "production-inpainted",
          ...(cached.sourceEvidenceReceipt
            ? { sourceEvidenceReceipt: cached.sourceEvidenceReceipt }
            : {}),
        },
        trace,
        fontInputPath,
        "font-replay-cache",
        modules,
      );
      pageReport.fontInferenceSource = inference.source;
      upsertPageReport(report, record, pageReport);
      replayed.push(record.page.id);
    } catch (error) {
      upsertPageReport(report, record, {
        status: "failed",
        stage: "font-replay-layout-render",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await persistReport(report);
  }
  report.cache = {
    sourceRun: config.cacheFrom,
    replayedPageIds: replayed,
    sourceGeometryDirectionReplay: summarizeSourceGeometryDirectionReplay(
      report.pages,
    ),
    fontInference: {
      mode: config.fontInferenceCacheMode || "off",
      validationVersion: CACHE_VALIDATION_VERSION,
      reusedPageIds: reusedInferencePageIds,
      livePageIds: liveInferencePageIds,
    },
  };
}

/** @param {any[]} records */
async function loadFontReplaySource(records) {
  const sealedCohortRecords =
    config.fontInferenceCacheMode === "off"
      ? await readJsonl(config.manifestPath)
      : records;
  const baselineSeal =
    config.fontInferenceCacheMode === "off"
      ? await loadFontReplayBaselineSeal({
          auditPath: config.cacheFromSeal,
          expectedRunDir: config.cacheFrom,
          expectedPageIds: sealedCohortRecords.map((record) => record.page.id),
        })
      : null;
  const sourceReport = JSON.parse(
    await fsp.readFile(path.join(config.cacheFrom, "run-report.json"), "utf8"),
  );
  if (sourceReport.cohortDigest !== config.cohortDigest) {
    throw new Error("cache-from was built from a different frozen cohort.");
  }
  return {
    baselineSeal,
    sourcePages: new Map(
      sourceReport.pages.map((page) => [page.sourcePageId, page]),
    ),
  };
}

/**
 * Mirror production's targetless completion without claiming an inpainted
 * asset. The replay still uses the frozen source raster for QA rendering.
 *
 * @param {any} page
 * @param {ReturnType<typeof loadModules>} modules
 */
function completeTargetlessFontReplayPage(page, modules) {
  if (!isQaTargetlessPage(page)) return page;
  let completedPage = { ...page, inpaintedImagePath: undefined };
  if (!completedPage.translationCompletion) {
    completedPage = seedQaTranslationCompletion(completedPage);
  }
  if (completedPage.translationCompletion?.status !== "pending") {
    return completedPage;
  }
  return modules.inpaintingCompletion.completeTranslationWorkflow(
    { page: completedPage, blocksErased: 0 },
    { requestedCompletionWorkflow: "bubble-layout" },
    FULL_PAGE_INPAINTING_TARGET,
  ).page;
}

/** @param {any} page @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
async function applyFontReplayLayout(page, modules, context) {
  return isQaTargetlessPage(page)
    ? page
    : applyFinalBubbleLayout(page, modules, context);
}

/** @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
async function prepareFontInferenceCacheRuntime(modules, context) {
  const mode = config.fontInferenceCacheMode || "off";
  if (mode === "off") return { runtime: null };
  const status = await loadFontInferenceRuntimeStatusInSubprocess(context);
  if (status.state !== "ready") {
    throw Object.assign(
      new Error(`Current font runtime is ${status.reason}.`),
      {
        code: `runtime_${status.reason}`,
      },
    );
  }
  return {
    runtime: {
      status,
      rendererHash:
        context.activeCatalog.sourceRecords.deploymentRenderBankManifestSha256,
      retiredFontIds: [
        ...modules.retiredFonts.RETIRED_AUTOMATIC_FONT_IDS,
      ].sort(),
    },
  };
}

/** @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
async function loadFontInferenceRuntimeStatusInSubprocess(context) {
  const inputPath = path.join(
    config.runDir,
    "tmp",
    "font-inference-cache-runtime-validation.json",
  );
  await fsp.mkdir(path.dirname(inputPath), { recursive: true });
  await writeJson(inputPath, {
    root: config.root,
    artifactDir: config.runtimeDir,
    allowQaOnlyRuntime: config.allowQaOnlyRuntime === true,
    installedCandidates: context.installedCandidates,
  });
  try {
    const validatorPath = path.join(
      __dirname,
      "font-inference-runtime-validator.cjs",
    );
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [validatorPath, inputPath],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    if (stderr.trim()) console.warn(stderr.trim());
    return JSON.parse(stdout);
  } finally {
    await fsp.rm(inputPath, { force: true });
  }
}

/**
 * @param {{ baselineSeal:any, cached: any, context: Awaited<ReturnType<typeof createRuntimeContext>>, fontInput: any, fontInputPath:string, inferenceCache: Awaited<ReturnType<typeof prepareFontInferenceCacheRuntime>>, modules: ReturnType<typeof loadModules>, neutralPage: any, record: any }} options
 */
async function resolveFontReplayPageInference(options) {
  if (options.inferenceCache.runtime) {
    const tracePath = resolveFontReplayInferencePath(
      config.cacheFrom,
      options.record,
      options.cached,
    );
    const trace = JSON.parse(await fsp.readFile(tracePath, "utf8"));
    const result = restoreCachedFontInference({
      cachedPage: options.cached,
      currentRuntime: options.inferenceCache.runtime,
      fontInput: options.fontInput,
      record: options.record,
      trace,
    });
    contextTraceFromCache(options.context, options.record, trace, tracePath);
    return { result, source: "cached" };
  }
  const directionReplay = await attachFontReplaySourceGeometryDirections({
    baselineSeal: options.baselineSeal,
    blocks: options.fontInput.requestBlocks,
    fontInputPath: options.fontInputPath,
    fontGeometryDirection: options.modules.fontGeometryDirection,
    pageId: options.record.page.id,
  });
  const request = {
    page: options.neutralPage,
    blocks: directionReplay.blocks,
    candidates: options.context.candidates,
    targetLanguage: "ko",
    boundary: { source: "user_page", datasetSplit: null, qaOverlay: false },
  };
  const result = await options.context.pageInference.inferPage(request);
  const trace = options.context.inferenceTraces.get(options.record.page.id);
  if (trace) trace.sourceGeometryDirectionReplay = directionReplay.audit;
  return { result, source: "live" };
}

function contextTraceFromCache(context, record, trace, tracePath) {
  context.inferenceTraces.set(record.page.id, {
    ...trace,
    elapsedMs: 0,
    cacheReuse: {
      schemaVersion: CACHE_VALIDATION_VERSION,
      sourceTracePath: tracePath,
      sourceElapsedMs: Number.isFinite(trace.elapsedMs)
        ? trace.elapsedMs
        : null,
    },
  });
}

/** @param {any} page @param {any[]} requestBlocks @param {any} inferred @param {any} record @param {any} profile @param {any} coordinator @param {ReturnType<typeof loadModules>} modules @param {any[]} candidates */
function applyReplayedFontDecisions(
  page,
  requestBlocks,
  inferred,
  record,
  profile,
  coordinator,
  modules,
  candidates,
) {
  const blocks = [...page.blocks];
  const { orderedItemIndexes, pageCoordinator, pixelInferences } =
    createFontReplayPageDecisionContext({
      automaticFontCoordinator: modules.automaticFontCoordinator,
      chapterCoordinator: coordinator,
      inferred,
      requestBlocks,
    });
  for (const itemIndex of orderedItemIndexes) {
    const entry = requestBlocks[itemIndex];
    const block = blocks[itemIndex];
    if (!entry || !block) continue;
    const decision = modules.automaticFont.resolveAutomaticFontDecisionV2({
      block,
      item: entry.item,
      page,
      options: {
        enabled: true,
        targetLanguage: "ko",
        workId: record.work.id,
        chapterId: record.chapter.id,
        profile,
        candidates,
        pageCoordinator,
        runtimeArtifactStatus: inferred.runtimeArtifactStatus,
        pixelInference: pixelInferences[itemIndex],
      },
    });
    const appliedBlock =
      modules.automaticFontApply.applyAutomaticFontDecisionV2(block, decision);
    blocks[itemIndex] = restoreFontReplaySemanticRole(appliedBlock, entry.item);
  }
  return { ...page, blocks };
}

/** @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
async function prepareInpainting(modules, context) {
  context.inpaintingLease =
    await modules.inpaintingPool.acquireInpaintingEngine({
      appPaths: context.appPaths,
      model: context.appSettings.inpainting?.model || "flux-klein",
      fluxBackend: context.appSettings.inpainting?.fluxBackend,
      koharuBackend: context.appSettings.inpainting?.koharuBackend,
      computeGpuIndex: context.appSettings.hardware?.computeGpuIndex,
      allowUnsafeLowMemoryFlux:
        context.appSettings.inpainting?.allowUnsafeLowMemoryFlux || false,
      onProgress: (progress) =>
        console.log(
          `[font-qa] inpainting: ${progress.progressText || progress.phase}`,
        ),
    });
  context.bubbleLayoutRunner =
    modules.bubbleFacade.createProductionBubbleLayoutRunner({
      dataRoot: context.appPaths.dataRoot,
    });
  context.bubbleLayoutConfig = {
    policy: "balanced",
    paddingRatio: context.appSettings.inpainting?.bubbleLayoutPaddingRatio,
    overwriteManual: false,
    naturalTextLayout: { locale: "ko" },
  };
}

/** @param {any} record @param {any} page @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
async function inpaintLayoutAndRender(record, page, modules, context) {
  const controller = new AbortController();
  const prepass = await modules.bubbleLayoutJob.runBubbleLayoutMaskPrepass({
    config: context.bubbleLayoutConfig,
    page,
    runner: context.bubbleLayoutRunner,
    signal: controller.signal,
  });
  const raw = await modules.inpainting.inpaintPatternPage(prepass.page, {
    signal: controller.signal,
    inpaintingEngine: context.inpaintingLease.engine,
    sourceEvidenceMode: "required",
    bubbleLayoutConstraintBlockIds: prepass.bubbleLayoutConstraintBlockIds,
    sharedInpaintGroupIdsByBlock: prepass.sharedInpaintGroupIdsByBlock,
  });
  const targetless = isQaTargetlessPage(prepass.page);
  assertQaInpaintingResultMatchesProduction(raw, { targetless });
  let restoredPage = raw.page;
  if (prepass.restoreLayout) {
    restoredPage = modules.inpaintingLayout.applyInpaintingLayoutStates(
      restoredPage,
      prepass.restoreLayout,
    );
  }
  const laidOut = targetless
    ? { page: restoredPage }
    : await modules.bubbleRunner.runBubbleLayoutPostprocess({
        config: context.bubbleLayoutConfig,
        ...(raw.erasedBlockIds?.length ? { blockIds: raw.erasedBlockIds } : {}),
        page: restoredPage,
        runner: context.bubbleLayoutRunner,
        signal: controller.signal,
      });
  const completed = modules.inpaintingCompletion.completeTranslationWorkflow(
    { ...raw, page: laidOut.page, bubbleLayoutPostprocessed: true },
    {
      bubbleLayoutPostprocess: context.bubbleLayoutConfig,
      requestedCompletionWorkflow: "bubble-layout",
    },
    FULL_PAGE_INPAINTING_TARGET,
  );
  const finalPage = completed.page;
  const qaCleanedImagePath = targetless
    ? await stageTargetlessCleanedAsset(record, finalPage.imagePath)
    : finalPage.inpaintedImagePath;
  const renderedImagePath = await renderPage(
    record,
    finalPage,
    modules,
    context,
  );
  return {
    ...finalPage,
    renderedImagePath,
    blocksErased: raw.blocksErased,
    blocksIncomplete: raw.blocksIncomplete || 0,
    qaCleanedImagePath,
    qaCleanedAssetKind: targetless
      ? "targetless-original-copy"
      : "production-inpainted",
    ...(raw.residualDiagnostics
      ? { residualDiagnostics: raw.residualDiagnostics }
      : {}),
    ...(raw.sourceEvidenceReceipt
      ? { sourceEvidenceReceipt: raw.sourceEvidenceReceipt }
      : {}),
  };
}

const FULL_PAGE_INPAINTING_TARGET = {
  blockId: undefined,
  drawnPatternMode: false,
  drawnStrokes: [],
  layoutOnly: false,
  targetType: "source",
};

async function stageTargetlessCleanedAsset(record, sourceImagePath) {
  const outputPath = path.join(pageOutputDir(record), "targetless-clean.png");
  await fsp.copyFile(sourceImagePath, outputPath);
  return outputPath;
}

/** @param {any} page @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
async function applyFinalBubbleLayout(page, modules, context) {
  context.bubbleLayoutRunner ??=
    modules.bubbleFacade.createProductionBubbleLayoutRunner({
      dataRoot: context.appPaths.dataRoot,
    });
  context.bubbleLayoutConfig ??= {
    policy: "balanced",
    paddingRatio: context.appSettings.inpainting?.bubbleLayoutPaddingRatio,
    overwriteManual: false,
    naturalTextLayout: { locale: "ko" },
  };
  const result = await modules.bubbleRunner.runBubbleLayoutPostprocess({
    config: context.bubbleLayoutConfig,
    page,
    runner: context.bubbleLayoutRunner,
    signal: new AbortController().signal,
  });
  return result.page;
}

/** @param {any} record @param {any} page @param {ReturnType<typeof loadModules>} modules @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
async function renderPage(record, page, modules, context) {
  const outputDir = pageOutputDir(record);
  await fsp.mkdir(outputDir, { recursive: true });
  const renderedImagePath = path.join(outputDir, "rendered.png");
  context.exportSession ??=
    await modules.pageExport.createPageExportRenderSession({
      dataRoot: config.runDir,
      decodeFallback: async () => null,
      resolveImageUrl: (imagePath) => {
        const extension = path.extname(imagePath).toLowerCase();
        const mime =
          extension === ".jpg" || extension === ".jpeg"
            ? "image/jpeg"
            : extension === ".webp"
              ? "image/webp"
              : "image/png";
        return `data:${mime};base64,${fs.readFileSync(imagePath).toString("base64")}`;
      },
    });
  const png = await context.exportSession.renderPage(page);
  await fsp.writeFile(renderedImagePath, png);
  return renderedImagePath;
}

/** @param {any} record */
async function stageFreshPage(record) {
  const outputDir = pageOutputDir(record);
  const sourceDir = path.join(outputDir, "source", "pages");
  await fsp.mkdir(sourceDir, { recursive: true });
  const stagedPath = path.join(
    sourceDir,
    `${String(record.page.index + 1).padStart(3, "0")}-${record.page.id}${path.extname(record.page.imagePath)}`,
  );
  await fsp.copyFile(record.page.imagePath, stagedPath);
  const chapter = JSON.parse(
    await fsp.readFile(record.chapter.jsonPath, "utf8"),
  );
  const sourcePage = chapter.pages.find((page) => page.id === record.page.id);
  if (!sourcePage) throw new Error("Frozen page is missing from chapter.json.");
  return {
    ...sourcePage,
    imagePath: stagedPath,
    inpaintedImagePath: undefined,
    dataUrl: "",
    blocks: [],
    analysisStatus: "idle",
    translationCompletion: undefined,
    lastError: undefined,
  };
}

/** @param {any} record @param {any} page @param {any} trace */
async function persistFontInput(record, page, trace) {
  if (!trace?.requestBlocks?.length && page.blocks.length) {
    throw new Error(
      "Font inference request trace is missing for translated blocks.",
    );
  }
  const filePath = path.join(pageOutputDir(record), "font-input.json");
  await writeJson(filePath, {
    schemaVersion: 1,
    sourcePageId: record.page.id,
    sourcePageSha256: record.page.imageSha256,
    page,
    requestBlocks: trace?.requestBlocks || [],
  });
  if (trace)
    await writeJson(
      path.join(pageOutputDir(record), "font-inference.json"),
      trace,
    );
  return filePath;
}

/**
 * Rebuild the pre-selection formatting for the QA replay input from the same
 * normalized defaults used by the production pipeline. Automatic matching no
 * longer stores a hidden previous-style snapshot on each block.
 *
 * @param {any} page
 * @param {any} formatDefaults
 * @param {{ applyFormatDefaultsToBlock: (block: any, defaults: any) => any }} blockFormat
 */
function buildFontReplayInput(page, formatDefaults, blockFormat) {
  return {
    ...page,
    blocks: page.blocks.map((block) => {
      const neutral = blockFormat.applyFormatDefaultsToBlock(
        block,
        formatDefaults,
      );
      delete neutral.fontRole;
      delete neutral.fontRoleConfidence;
      return neutral;
    }),
  };
}

/** @param {any} record @param {any} processedPage @param {any} trace @param {string} fontInputPath @param {string} mode @param {ReturnType<typeof loadModules>} modules */
async function buildCompletedPageReport(
  record,
  processedPage,
  trace,
  fontInputPath,
  mode,
  modules,
) {
  const renderedImagePath = processedPage.renderedImagePath;
  const pageRelativeRoleQa = summarizePageRelativeRoleQa(trace);
  const evidenceSourceImagePath =
    mode === "font-replay-cache" &&
    processedPage.sourceEvidenceReceipt?.source?.assetPath
      ? processedPage.sourceEvidenceReceipt.source.assetPath
      : processedPage.imagePath;
  const completion = await resolveQaPageCompletion({
    executionStatus: "completed",
    translationCompletion: processedPage.translationCompletion,
    cleanedImagePath:
      processedPage.qaCleanedImagePath ?? processedPage.inpaintedImagePath,
    cleanedAssetKind:
      processedPage.qaCleanedAssetKind ?? "production-inpainted",
    blocksIncomplete: processedPage.blocksIncomplete,
    sourceEvidenceBindingRequired: true,
    sourceEvidenceReceipt: processedPage.sourceEvidenceReceipt,
    expectedSourceImagePath: evidenceSourceImagePath,
    expectedSourcePageId: record.page.id,
    expectedSourceSha256: record.page.imageSha256,
  });
  return {
    ...completion,
    mode,
    blockCount: processedPage.blocks.length,
    blocksErased: processedPage.blocksErased,
    blocksIncomplete: processedPage.blocksIncomplete,
    ...(processedPage.residualDiagnostics
      ? { residualDiagnostics: processedPage.residualDiagnostics }
      : {}),
    ...(processedPage.sourceEvidenceReceipt
      ? { sourceEvidenceReceipt: processedPage.sourceEvidenceReceipt }
      : {}),
    stagedOriginalImagePath: evidenceSourceImagePath,
    ...(evidenceSourceImagePath !== processedPage.imagePath
      ? { replayInputImagePath: processedPage.imagePath }
      : {}),
    cleanedImagePath:
      processedPage.qaCleanedImagePath ?? processedPage.inpaintedImagePath,
    cleanedAssetKind:
      processedPage.qaCleanedAssetKind ?? "production-inpainted",
    productionInpaintedImagePath: processedPage.inpaintedImagePath ?? null,
    renderedImagePath,
    renderedImageSha256: await sha256File(renderedImagePath),
    fontInputPath,
    fontInferencePath: trace
      ? path.join(pageOutputDir(record), "font-inference.json")
      : null,
    fontDecisions: buildFontDecisionLog(
      processedPage,
      trace,
      modules.textOutline,
    ),
    ...(trace?.sourceGeometryDirectionReplay
      ? {
          sourceGeometryDirectionReplay: trace.sourceGeometryDirectionReplay,
        }
      : {}),
    ...(pageRelativeRoleQa ? { pageRelativeRoleQa } : {}),
  };
}

/** @param {any} record @param {any} fontInput */
function assertCachedInput(record, fontInput) {
  if (
    fontInput.sourcePageId !== record.page.id ||
    fontInput.sourcePageSha256 !== record.page.imageSha256
  ) {
    throw new Error("Cached font input does not match the frozen source page.");
  }
  if (
    !Array.isArray(fontInput.page?.blocks) ||
    !Array.isArray(fontInput.requestBlocks)
  ) {
    throw new Error("Cached font input is incomplete.");
  }
}

/** @param {any[]} records @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
function createInitialReport(records, context) {
  return {
    schemaVersion: 1,
    completionSemanticsVersion: QA_PAGE_COMPLETION_CONTRACT_VERSION,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    runId: config.runId,
    cohort: config.cohort,
    cohortDigest: config.cohortDigest,
    candidateId: config.candidateId,
    candidateRuntimeDir: config.runtimeDir,
    qaPageRelativeRoleReroute: config.qaPageRelativeRoleReroute === true,
    cacheFrom: config.cacheFrom,
    provider: context.appSettings.modelProvider,
    targetLanguage: context.appSettings.translation?.targetLanguage,
    pageCount: records.length,
    pages: [],
  };
}

/** @param {ReturnType<typeof createInitialReport>} report @param {any} record @param {Record<string, any>} update */
function upsertPageReport(report, record, update) {
  if (!record) return;
  const index = report.pages.findIndex(
    (page) => page.sourcePageId === record.page.id,
  );
  const base = {
    selectionIndex: record.selectionIndex,
    sourcePageId: record.page.id,
    sourcePageName: record.page.name,
    sourcePageSha256: record.page.imageSha256,
    workId: record.work.id,
    workTitle: record.work.title,
    chapterId: record.chapter.id,
    chapterTitle: record.chapter.title,
  };
  if (index >= 0) report.pages[index] = { ...report.pages[index], ...update };
  else report.pages.push({ ...base, ...update });
  report.pages.sort(
    (left, right) => left.selectionIndex - right.selectionIndex,
  );
}

/** @param {ReturnType<typeof createInitialReport>} report */
async function persistReport(report) {
  await writeJson(path.join(config.runDir, "run-report.json"), report);
}

/** @param {ReturnType<typeof createInitialReport>} report */
async function writeReviewHtml(report) {
  const cards = report.pages
    .map((page) => {
      const original = page.stagedOriginalImagePath
        ? relativeFileUrl(config.runDir, page.stagedOriginalImagePath)
        : "";
      const rendered = page.renderedImagePath
        ? relativeFileUrl(config.runDir, page.renderedImagePath)
        : "";
      const fontCounts = countFonts(page.fontDecisions || []);
      return `<section><h2>${escapeHtml(`${page.selectionIndex + 1}. ${page.workTitle} / ${page.chapterTitle} / ${page.sourcePageName}`)}</h2><p>${escapeHtml(page.status)} · ${escapeHtml(JSON.stringify(fontCounts))}</p><div class="pair">${original ? `<img src="${escapeHtml(original)}">` : ""}${rendered ? `<img src="${escapeHtml(rendered)}">` : ""}</div></section>`;
    })
    .join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>Font QA ${escapeHtml(report.candidateId)}</title><style>body{margin:0;background:#111;color:#eee;font-family:Arial,sans-serif}section{padding:16px;border-bottom:1px solid #444}h2{font-size:16px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}.pair img{width:100%;max-height:90vh;object-fit:contain;background:#222}</style>${cards}`;
  await fsp.writeFile(path.join(config.runDir, "review.html"), html, "utf8");
}

/** @param {any[]} decisions */
function countFonts(decisions) {
  const counts = {};
  for (const decision of decisions) {
    const key =
      decision.selectedFontId ||
      `unapplied:${decision.effectiveFontFamily || "default"}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/** @param {any[]} records */
function groupByChapter(records) {
  const groups = [];
  const byChapter = new Map();
  for (const record of records) {
    let group = byChapter.get(record.chapter.id);
    if (!group) {
      group = [];
      groups.push(group);
      byChapter.set(record.chapter.id, group);
    }
    group.push(record);
  }
  return groups;
}

/** @param {any} event */
function logProgress(event) {
  if (event?.progressText) {
    console.log(`[font-qa] ${event.progressText}`);
  }
}

/** @param {any[]} records */
function assertCohort(records) {
  if (records.length === 0) throw new Error("Frozen cohort is empty.");
  const pageIds = new Set();
  for (const record of records) {
    if (pageIds.has(record.page.id))
      throw new Error("Frozen cohort contains duplicate pages.");
    pageIds.add(record.page.id);
    const actual = sha256FileSync(record.page.imagePath);
    if (actual !== record.page.imageSha256) {
      throw new Error(`Frozen source page changed: ${record.page.id}`);
    }
  }
}

/** @param {Awaited<ReturnType<typeof createRuntimeContext>>} context */
function redactConfig(context) {
  return {
    ...config,
    provider: context.appSettings.modelProvider,
    model:
      context.appSettings.modelProvider === "gemma"
        ? {
            source: context.appSettings.gemma?.modelSource,
            repo: context.appSettings.gemma?.modelRepo,
            file: context.appSettings.gemma?.modelFile,
          }
        : { remote: true },
    candidateCount: context.candidates.length,
  };
}

/** @param {any} record */
function pageOutputDir(record) {
  return path.join(
    config.runDir,
    "pages",
    String(record.selectionIndex + 1).padStart(2, "0"),
  );
}

/** @param {string} root @param {string} target */
function relativeFileUrl(root, target) {
  return path.relative(root, target).replace(/\\/g, "/");
}

/** @param {string} filePath @param {unknown} value */
async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

/** @param {string} filePath */
async function readJsonl(filePath) {
  return (await fsp.readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readConfig() {
  const raw = process.env.MGT_LIBRARY_FONT_QA_CONFIG;
  if (!raw) throw new Error("MGT_LIBRARY_FONT_QA_CONFIG is required.");
  const parsed = JSON.parse(raw);
  if (!parsed.execute)
    throw new Error("Electron runner requires execute=true.");
  if (
    parsed.fontInferenceCacheMode !== "off" &&
    parsed.fontInferenceCacheMode !== "required"
  ) {
    throw new Error(
      "Electron runner requires an explicit font inference cache mode.",
    );
  }
  if (
    parsed.qaPageRelativeRoleReroute === true &&
    parsed.fontInferenceCacheMode !== "off"
  ) {
    throw new Error(
      "Page-relative role QA requires live font inference, not cached inference.",
    );
  }
  if (
    parsed.cacheFrom &&
    parsed.fontInferenceCacheMode === "off" &&
    typeof parsed.cacheFromSeal !== "string"
  ) {
    throw new Error(
      "Live font replay requires a fresh baseline cacheFromSeal.",
    );
  }
  if (parsed.cacheFromSeal && !parsed.cacheFrom) {
    throw new Error("cacheFromSeal requires cacheFrom.");
  }
  if (
    parsed.qaPageRelativeRoleReroute === true &&
    (!parsed.cacheFrom || typeof parsed.cacheFromSeal !== "string")
  ) {
    throw new Error(
      "Page-relative role QA requires a sealed 40-page fresh baseline replay.",
    );
  }
  return parsed;
}

/** @param {string} filePath */
function sha256FileSync(filePath) {
  return nodeCrypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

/** @param {string} filePath */
async function sha256File(filePath) {
  const hash = nodeCrypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
