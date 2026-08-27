// @ts-check
const {
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
} = require("../simple-page-model-config.cjs");
const { runtimeOverrideEnv } = require("../simple-page-child-env.cjs");
const { inspectModelLaunch } = require("../simple-page-model-assets.cjs");
const { buildOptionSummary } = require("../simple-page-request-summary.cjs");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");
const {
  shouldUseBeellamaGemmaLaunch,
} = require("./model-runtime-compatibility.cjs");
const {
  buildGemma4OfficialChatTemplateArgs,
} = require("./gemma4-official-chat-template.cjs");
const { resolveComputeGpuIndex } = require("../compute-gpu-selection.cjs");
const { resolveLlamaRuntimeProfile } = require("./runtime-profile.cjs");

/** @typedef {Record<string, any>} LaunchOptions */
/** @typedef {ReturnType<typeof inspectModelLaunch>} LaunchTarget */

/**
 * @param {LaunchOptions} options
 * @returns {string[]}
 */
function buildLaunchArgs(options) {
  const launchTarget = inspectModelLaunch(options);
  assertLaunchTarget(options, launchTarget);
  const useBeellama = shouldUseBeellamaGemmaLaunch(options);
  const args = [
    ...buildModelSelectionArgs(options, launchTarget),
    ...buildDraftArgs(options, launchTarget),
    ...buildNetworkArgs(options),
    ...buildSamplingArgs(options),
    ...buildComputeArgs(options, useBeellama),
    ...buildGemma4OfficialChatTemplateArgs(options),
  ];
  appendBeellamaArgs(args, options, useBeellama);
  appendPerformanceArgs(args, options);
  appendCacheArgs(args, options);
  appendImageArgs(args, options);
  appendExtraArgs(args, options);
  args.push("--log-timestamps", "--log-prefix", "--log-colors", "off");
  return args;
}

/** @param {LaunchOptions} options @param {LaunchTarget} target */
function assertLaunchTarget(options, target) {
  if (target.launchMode !== "local" || target.modelPath) {
    return;
  }
  throw createDetailedError("로컬 모델 파일 경로가 설정되지 않았습니다.", {
    optionSummary: buildOptionSummary(options),
  });
}

/** @param {LaunchOptions} options @param {LaunchTarget} target @returns {string[]} */
function buildModelSelectionArgs(options, target) {
  const mmprojArgs = target.mmprojPath
    ? ["--mmproj", target.mmprojPath]
    : target.mmprojUrl
      ? ["--mmproj-url", target.mmprojUrl]
      : [];
  if (["local", "cached-hf"].includes(target.launchMode) && target.modelPath) {
    return ["-m", target.modelPath, ...mmprojArgs];
  }
  return [
    "-hf",
    resolveConfiguredModelRepo(options),
    "-hff",
    resolveConfiguredModelFile(options),
    ...mmprojArgs,
  ];
}

/** @param {LaunchOptions} options @param {LaunchTarget} target @returns {string[]} */
function buildDraftArgs(options, target) {
  if (!options.useDraft || (!target.draftModelPath && !target.draftModelUrl)) {
    return [];
  }
  const specType = resolveDraftSpecType(options.draftSpecType);
  const args = [
    target.draftModelPath ? "--spec-draft-model" : "--spec-draft-hf",
    target.draftModelPath || resolveDraftModelRepoArg(options),
    "--spec-type",
    specType,
    "--spec-draft-ngl",
    "all",
    "--spec-draft-n-max",
    String(resolveDraftMaxTokens(options)),
  ];
  if (specType === "dflash") {
    args.push("--spec-dflash-cross-ctx", "512", "--spec-branch-budget", "0");
  }
  return args;
}

/** @param {LaunchOptions} options */
function resolveDraftMaxTokens(options) {
  const configured = Number(options.draftMaxTokens);
  return Number.isInteger(configured) && configured >= 1 && configured <= 16
    ? configured
    : 16;
}

/** @param {unknown} value */
function resolveDraftSpecType(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "draft-mtp"
    ? "draft-mtp"
    : "dflash";
}

/** @param {LaunchOptions} options */
function buildNetworkArgs(options) {
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--repeat-last-n",
    runtimeOverrideEnv("MANGA_TRANSLATOR_REPEAT_LAST_N", options) || "256",
    "--repeat-penalty",
    runtimeOverrideEnv("MANGA_TRANSLATOR_REPEAT_PENALTY", options) || "1.08",
    "--presence-penalty",
    "0",
    "--frequency-penalty",
    "0",
  ];
}

/** @param {LaunchOptions} options */
function buildSamplingArgs(options) {
  return [
    "--temp",
    String(
      options.temperature ??
        configuredSamplingValue(options, "MANGA_TRANSLATOR_TEMPERATURE", "0.2"),
    ),
    "--top-k",
    String(
      options.topK ??
        configuredSamplingValue(options, "MANGA_TRANSLATOR_TOP_K", "64"),
    ),
    "--top-p",
    String(
      options.topP ??
        configuredSamplingValue(options, "MANGA_TRANSLATOR_TOP_P", "0.95"),
    ),
    "--min-p",
    String(configuredSamplingValue(options, "MANGA_TRANSLATOR_MIN_P", "0.0")),
    "-rea",
    "off",
    "--reasoning-budget",
    "0",
  ];
}

/** @param {LaunchOptions} options @param {string} key @param {string} fallback */
function configuredSamplingValue(options, key, fallback) {
  return runtimeOverrideEnv(key, options) ?? fallback;
}

/** @param {LaunchOptions} options @param {boolean} useBeellama */
function buildComputeArgs(options, useBeellama) {
  const fitArgs = useBeellama
    ? []
    : options.fitEnabled === false
      ? ["--fit", "off"]
      : [
          "--fit",
          "on",
          "--fit-target",
          String(options.fitTargetMb),
          // llama.cpp otherwise defaults --fit-ctx to 4096 and may silently
          // shrink the requested context before reducing GPU layer offload.
          // Keep the configured context as a hard requirement instead.
          "--fit-ctx",
          String(options.ctx),
        ];
  const gpuLayerArgs =
    options.gpuLayers === "fit"
      ? ["-ngl", "auto"]
      : ["-ngl", String(options.gpuLayers ?? "all")];
  const computeGpuIndex =
    resolveLlamaRuntimeProfile(options) === "metal"
      ? null
      : resolveComputeGpuIndex(options.computeGpuIndex);
  const disableMmap = !useBeellama && options.disableMmap === true;
  const gpuSelectionArgs =
    computeGpuIndex === null
      ? []
      : ["--split-mode", "none", "--main-gpu", String(computeGpuIndex)];
  return [
    ...fitArgs,
    ...gpuLayerArgs,
    ...gpuSelectionArgs,
    "-fa",
    "on",
    "-c",
    String(options.ctx),
    "-b",
    String(options.batch),
    "-ub",
    String(options.ubatch),
    "-np",
    "1",
    ...(useBeellama ? [] : ["--no-cache-prompt", "--no-warmup"]),
    ...(disableMmap ? ["--no-mmap"] : []),
    options.mmprojOffload === true ? "--mmproj-offload" : "--no-mmproj-offload",
    "--cache-ram",
    "0",
  ];
}

/** @param {string[]} args @param {LaunchOptions} options @param {boolean} enabled */
function appendBeellamaArgs(args, options, enabled) {
  if (!enabled) return;
  args.push("--kv-unified", "--jinja", "--no-mmap", "--mlock");
  if (options.noHost !== false) args.push("--no-host");
}

/** @param {string[]} args @param {string} flag @param {unknown} value */
function appendPositiveNumber(args, flag, value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    args.push(flag, String(Math.round(value)));
  }
}

/** @param {string[]} args @param {LaunchOptions} options */
function appendPerformanceArgs(args, options) {
  appendPositiveNumber(args, "--threads", options.threads);
  appendPositiveNumber(args, "--threads-batch", options.threadsBatch);
  appendPollingArgs(args, options);
  appendSlotArgs(args, options);
  appendTelemetryArgs(args, options);
}

/** @param {string[]} args @param {LaunchOptions} options */
function appendPollingArgs(args, options) {
  if (typeof options.poll === "number" && Number.isFinite(options.poll)) {
    args.push(
      "--poll",
      String(Math.max(0, Math.min(100, Math.round(options.poll)))),
    );
  }
  if (typeof options.pollBatch === "boolean") {
    args.push("--poll-batch", options.pollBatch ? "1" : "0");
  }
  if (
    typeof options.prioBatch === "number" &&
    Number.isFinite(options.prioBatch)
  ) {
    args.push(
      "--prio-batch",
      String(Math.max(0, Math.min(3, Math.round(options.prioBatch)))),
    );
  }
}

/** @param {string[]} args @param {LaunchOptions} options */
function appendSlotArgs(args, options) {
  if (typeof options.cacheIdleSlots === "boolean") {
    args.push(
      options.cacheIdleSlots ? "--cache-idle-slots" : "--no-cache-idle-slots",
    );
  }
  if (
    typeof options.cacheReuse === "number" &&
    Number.isFinite(options.cacheReuse) &&
    options.cacheReuse >= 0
  ) {
    args.push("--cache-reuse", String(Math.round(options.cacheReuse)));
  }
}

/** @param {string[]} args @param {LaunchOptions} options */
function appendTelemetryArgs(args, options) {
  if (options.enableMetrics === true) args.push("--metrics");
  if (typeof options.enablePerf === "boolean") {
    args.push(options.enablePerf ? "--perf" : "--no-perf");
  }
}

/** @param {string[]} args @param {string} flag @param {unknown} value */
function appendConfiguredValue(args, flag, value) {
  if (value !== undefined && value !== null && value !== "") {
    args.push(flag, String(value));
  }
}

/** @param {string[]} args @param {LaunchOptions} options */
function appendCacheArgs(args, options) {
  appendConfiguredValue(args, "--cache-type-k", options.cacheTypeK);
  appendConfiguredValue(args, "--cache-type-v", options.cacheTypeV);
  if (options.kvOffload === false) args.push("--no-kv-offload");
  if (options.kvOffload === true) args.push("--kv-offload");
  if (
    typeof options.ctxCheckpoints === "number" &&
    Number.isFinite(options.ctxCheckpoints)
  ) {
    args.push("--ctx-checkpoints", String(options.ctxCheckpoints));
  }
}

/** @param {string[]} args @param {LaunchOptions} options */
function appendImageArgs(args, options) {
  if (
    typeof options.imageMinTokens === "number" &&
    Number.isFinite(options.imageMinTokens)
  ) {
    args.push("--image-min-tokens", String(options.imageMinTokens));
  }
  if (
    typeof options.imageMaxTokens === "number" &&
    Number.isFinite(options.imageMaxTokens)
  ) {
    args.push("--image-max-tokens", String(options.imageMaxTokens));
  }
}

/** @param {string[]} args @param {LaunchOptions} options */
function appendExtraArgs(args, options) {
  if (!Array.isArray(options.extraArgs)) return;
  for (const arg of options.extraArgs) {
    if (typeof arg === "string" && arg.trim()) args.push(arg.trim());
  }
}

/** @param {LaunchOptions} [options] */
function resolveDraftModelRepoArg(options = {}) {
  const repo = resolveConfiguredDraftModelRepo(options);
  const file = resolveConfiguredDraftModelFile(options);
  if (resolveDraftSpecType(options.draftSpecType) === "draft-mtp") {
    return repo;
  }
  const quant = file.match(/-([A-Za-z0-9_]+)\.gguf$/)?.[1];
  return quant ? `${repo}:${quant}` : repo;
}

module.exports = { buildLaunchArgs };
