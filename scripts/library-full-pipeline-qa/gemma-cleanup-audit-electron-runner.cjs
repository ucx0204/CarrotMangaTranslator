// @ts-check

const { app } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { sealRecord } = require("./gemma-cleanup-audit-contract.cjs");
const {
  assertShadowRuntimeTargets,
  assertShadowWriteTargets,
  loadFrozenAuditInputs,
} = require("./gemma-cleanup-audit-inputs.cjs");
const {
  createExclusiveDirectory,
  prepareAuditPage,
  runAuditPage,
  writeExperimentArtifacts,
} = require("./gemma-cleanup-audit-runner.cjs");
const {
  acquireAuditRunLock,
  buildAuditRunPaths,
  buildLiveRuntimeBinding,
} = require("./gemma-cleanup-audit-runtime.cjs");

/** @typedef {{root:string;indices:number[];outputRoot:string;cacheDir:string;runId:string}} RunnerConfig */

// Electron does not set require.main to the launched script. This file is an
// entry-only main-process runner, so invoke it unconditionally like the other
// QA Electron entrypoints.
main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
  app.exit(1);
});

async function main() {
  const config = readRunnerConfig();
  const runPaths = buildAuditRunPaths(config.root, config.runId);
  const runtimeWriteGuard = () =>
    assertShadowRuntimeTargets({ root: config.root, ...runPaths });
  await runtimeWriteGuard();
  await fsp.mkdir(runPaths.userData, { recursive: true });
  await runtimeWriteGuard();
  prepareElectron(runPaths.userData);
  await app.whenReady();
  await runtimeWriteGuard();
  const lock = await acquireAuditRunLock({
    ...config,
    writeGuard: runtimeWriteGuard,
  });
  await runtimeWriteGuard();
  const runtime = loadRuntimeModules(config.root);
  /** @type {{baseUrl:string;[key:string]:unknown}|null} */
  let server = null;
  /** @type {unknown[]} */
  const cleanupErrors = [];
  try {
    const inputs = await loadFrozenAuditInputs({
      root: config.root,
      indices: config.indices,
    });
    const writeGuard = async () => {
      await runtimeWriteGuard();
      await assertShadowWriteTargets({
        root: config.root,
        runRoot: inputs.runRoot,
        outputRoot: config.outputRoot,
        cacheDir: config.cacheDir,
      });
    };
    await writeGuard();
    await createExclusiveDirectory(config.outputRoot, writeGuard);
    await writeGuard();
    await fsp.mkdir(config.cacheDir, { recursive: true });
    await writeGuard();
    const options = await buildLiveOptions(
      config,
      runtime,
      inputs.manifest.model,
      runPaths,
    );
    // startServer is the sole asset-preparation call. The receipt below hashes
    // child.spawnfile/spawnargs only after preparation and launch completed.
    await writeGuard();
    server = await runtime.simplePage.startServer(options);
    await writeGuard();
    const launchedServer = server;
    if (!launchedServer) {
      throw new Error("Cleanup audit server failed to start.");
    }
    const runtimeSeal = await buildLiveRuntimeBinding({
      options,
      expectedModel: inputs.manifest.model,
      launchedServer,
      inspectModelLaunch: runtime.modelAssets.inspectModelLaunch,
      resolveRequestModelName: runtime.requestSummary.resolveRequestModelName,
      verifyChatTemplate: runtime.chatTemplate.verifyGemma4OfficialChatTemplate,
      templateProvenance: {
        revision: runtime.chatTemplate.GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION,
        expectedSha256:
          runtime.chatTemplate.GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256,
        expectedBytes: runtime.chatTemplate.GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES,
        source: runtime.chatTemplate.GEMMA4_OFFICIAL_CHAT_TEMPLATE_SOURCE,
      },
    });
    const prepared = inputs.pages.map((page) =>
      prepareAuditPage({
        page: /** @type {any} */ (page),
        modelName: runtimeSeal.modelName,
        runtimeBinding: runtimeSeal.binding,
      }),
    );
    /** @type {(input:{requestBody:Record<string,unknown>})=>Promise<{rawResponseText:string;outputText:string;finishReason:string}>} */
    const requester = async ({ requestBody }) => {
      const activeServer = server;
      if (!activeServer)
        throw new Error("Cleanup audit server is unavailable.");
      await writeGuard();
      const response = await requestLocalCompletion(activeServer, requestBody);
      await writeGuard();
      return response;
    };
    const outcomes = [];
    for (const page of prepared) {
      outcomes.push(
        await runAuditPage({
          prepared: page,
          requester,
          cacheDir: config.cacheDir,
          writeGuard,
        }),
      );
    }
    const sourceBinding = sealRecord({
      contractVersion: inputs.manifest.contractVersion,
      shadowOnly: true,
      promotionEligible: false,
      productionMutationAllowed: false,
      evaluationRole: inputs.manifest.evaluationRole,
      holdoutEligible: inputs.manifest.holdoutEligible,
      consumedDevelopmentEvidence: inputs.manifest.consumedDevelopmentEvidence,
      frozenManifestPath: inputs.manifestPath,
      frozenManifestSha256: inputs.manifestSha256,
      runReportPath: inputs.runReportPath,
      runReportSha256: inputs.runReportSha256,
      runConfigPath: inputs.runConfigPath,
      runConfigSha256: inputs.runConfigSha256,
      manualLedgerPath: inputs.ledgerPath,
      manualLedgerSha256: inputs.ledgerSha256,
      selectionIndices: config.indices,
      pageIds: inputs.pages.map((page) => page.pageId),
      legacyRunStatusMeaning: inputs.manifest.source.legacyRunStatusMeaning,
    });
    const report = await writeExperimentArtifacts({
      outputRoot: config.outputRoot,
      outputAlreadyCreated: true,
      sourceBinding,
      runtimeBinding: runtimeSeal.binding,
      outcomes,
      writeGuard,
    });
    console.log(
      `[cleanup-audit] ${report.status} pages=${outcomes.length} output=${config.outputRoot}`,
    );
  } finally {
    if (server) {
      try {
        await runtimeWriteGuard();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await runtime.simplePage.stopServer(server);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await runtimeWriteGuard();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await lock.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Cleanup audit runtime cleanup failed closed.",
    );
  }
  await runtimeWriteGuard();
  app.quit();
}

/** @param {RunnerConfig} config @param {ReturnType<typeof loadRuntimeModules>} runtime @param {Record<string,any>} model @param {ReturnType<typeof buildAuditRunPaths>} runPaths */
async function buildLiveOptions(config, runtime, model, runPaths) {
  const paths = runtime.appPaths.getAppPaths();
  const settings = runtime.appSettings.normalizeAppSettings(
    await readJsonIfExists(paths.settingsPath),
  );
  const configured = runtime.appSettings.buildBaseTranslationOptions({
    jobId: "gemma-cleanup-audit-shadow",
    runDir: runPaths.runRoot,
    paths,
    settings,
  });
  return {
    ...configured,
    modelProvider: "gemma",
    modelSource: "huggingface",
    modelRepo: model.repo,
    modelFile: model.file,
    mmprojRepo: model.mmproj.repo,
    mmprojFile: model.mmproj.file,
    includeEnhancedVariant: false,
    useDraft: false,
    reuseServer: false,
    cacheReuse: 0,
    cacheIdleSlots: 0,
    label: "gemma-cleanup-audit-shadow",
    serverLogPath: runPaths.serverLog,
  };
}

/** @param {{baseUrl:string}} server @param {Record<string,unknown>} requestBody */
async function requestLocalCompletion(server, requestBody) {
  const response = await fetch(`${server.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer local-no-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const rawResponseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Cleanup audit Gemma request failed (${response.status}): ${rawResponseText.slice(0, 1000)}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(rawResponseText);
  } catch (error) {
    throw new Error("Cleanup audit server returned invalid transport JSON.", {
      cause: error,
    });
  }
  const outputText = readOutputText(parsed);
  const finishReason = readFinishReason(parsed);
  if (!outputText.trim()) {
    throw new Error("Cleanup audit server returned empty model output.");
  }
  if (!finishReason) {
    throw new Error("Cleanup audit server omitted finish_reason.");
  }
  return { rawResponseText, outputText, finishReason };
}

/** @param {unknown} response */
function readOutputText(response) {
  if (!response || typeof response !== "object") return "";
  const choices = Reflect.get(response, "choices");
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = Reflect.get(first, "message");
  if (!message || typeof message !== "object") return "";
  const content = Reflect.get(message, "content");
  return typeof content === "string" ? content : "";
}

/** @param {unknown} response */
function readFinishReason(response) {
  if (!response || typeof response !== "object") return "";
  const choices = Reflect.get(response, "choices");
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const finishReason = Reflect.get(first, "finish_reason");
  return typeof finishReason === "string" ? finishReason : "";
}

/** @param {string} userDataPath */
function prepareElectron(userDataPath) {
  app.setPath("userData", userDataPath);
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disk-cache-size", "0");
  app.on("window-all-closed", () => {});
}

/** @param {string} root */
function loadRuntimeModules(root) {
  /** @param {string} relativePath */
  const load = (relativePath) => require(path.join(root, relativePath));
  return {
    appPaths: load("out/main/appPaths.js"),
    appSettings: load("out/main/appSettings.js"),
    simplePage: load("out/app-runtime/simple-page-translate.cjs"),
    modelAssets: load("out/app-runtime/simple-page-model-assets.cjs"),
    runtimePaths: load("out/app-runtime/simple-page-runtime-paths.cjs"),
    requestSummary: load("out/app-runtime/simple-page-request-summary.cjs"),
    launchArgs: load("out/app-runtime/simple-page-launch-args.cjs"),
    chatTemplate: load(
      "out/app-runtime/model/gemma4-official-chat-template.cjs",
    ),
  };
}

/** @param {string} filePath */
async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

/** @returns {RunnerConfig} */
function readRunnerConfig() {
  const raw = process.env.MGT_GEMMA_CLEANUP_AUDIT_CONFIG;
  if (!raw) throw new Error("Cleanup audit Electron config is missing.");
  const parsed = /** @type {Record<string,unknown>} */ (JSON.parse(raw));
  const indices = Array.isArray(parsed.indices)
    ? parsed.indices.map((value) => Number(value))
    : [];
  if (
    typeof parsed.root !== "string" ||
    typeof parsed.outputRoot !== "string" ||
    typeof parsed.cacheDir !== "string" ||
    typeof parsed.runId !== "string" ||
    indices.length === 0 ||
    indices.some((value) => !Number.isInteger(value))
  ) {
    throw new Error("Cleanup audit Electron config is invalid.");
  }
  return {
    root: path.resolve(parsed.root),
    indices,
    outputRoot: path.resolve(parsed.outputRoot),
    cacheDir: path.resolve(parsed.cacheDir),
    runId: parsed.runId,
  };
}

module.exports = {
  buildLiveOptions,
  loadRuntimeModules,
  readOutputText,
  readFinishReason,
  readRunnerConfig,
  requestLocalCompletion,
};
