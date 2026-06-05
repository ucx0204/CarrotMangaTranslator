const path = require("node:path");

const {
  DEFAULT_HF_FILE,
  DEFAULT_MODEL_HF
} = require("./simple-page-defaults.cjs");
const {
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo
} = require("./simple-page-model-config.cjs");
const {
  runtimeOverrideEnv
} = require("./simple-page-child-env.cjs");
const {
  defaultServerPath,
  isGemma26BModel,
  isGemma31BModel
} = require("./simple-page-runtime-paths.cjs");
const {
  inspectModelLaunch
} = require("./simple-page-model-assets.cjs");
const {
  buildOptionSummary
} = require("./simple-page-request-summary.cjs");
const {
  createDetailedError
} = require("./simple-page-runtime-common.cjs");

function buildLaunchArgs(options) {
  const launchTarget = inspectModelLaunch(options);
  if (launchTarget.launchMode === "local" && !launchTarget.modelPath) {
    throw createDetailedError("로컬 모델 파일 경로가 설정되지 않았습니다.", {
      optionSummary: buildOptionSummary(options)
    });
  }
  const useBeellamaGemmaLaunch = shouldUseBeellamaGemmaLaunch(options);
  const gpuLayerArgs =
    options.gpuLayers === "fit"
      ? ["-ngl", "auto"]
      : [
          "-ngl",
          String(options.gpuLayers ?? "all")
        ];
  const draftArgs =
    options.useDraft && (launchTarget.draftModelPath || launchTarget.draftModelUrl)
      ? [
          launchTarget.draftModelPath ? "--spec-draft-model" : "--spec-draft-hf",
          launchTarget.draftModelPath || resolveDraftModelRepoArg(options),
          "--spec-type",
          "dflash",
          "--spec-dflash-cross-ctx",
          "512",
          "--spec-draft-ngl",
          "all",
          "--spec-draft-n-max",
          "16",
          "--spec-branch-budget",
          "0"
        ]
      : [];
  const args = [
    ...((launchTarget.launchMode === "local" || launchTarget.launchMode === "cached-hf") && launchTarget.modelPath
      ? [
          "-m",
          launchTarget.modelPath,
          ...(launchTarget.mmprojPath
            ? [
                "--mmproj",
                launchTarget.mmprojPath
              ]
            : launchTarget.mmprojUrl
              ? [
                  "--mmproj-url",
                  launchTarget.mmprojUrl
                ]
            : [])
        ]
      : [
          "-hf",
          resolveConfiguredModelRepo(options),
          "-hff",
          resolveConfiguredModelFile(options),
          ...(launchTarget.mmprojPath
            ? [
                "--mmproj",
                launchTarget.mmprojPath
              ]
            : launchTarget.mmprojUrl
              ? [
                  "--mmproj-url",
                  launchTarget.mmprojUrl
                ]
              : [])
        ]),
    ...draftArgs,
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
    ...(useBeellamaGemmaLaunch ? [] : ["--fit", "on", "--fit-target", String(options.fitTargetMb)]),
    ...gpuLayerArgs,
    "-fa",
    "on",
    "--temp",
    String(options.temperature ?? runtimeOverrideEnv("MANGA_TRANSLATOR_TEMPERATURE", options) ?? "0.2"),
    "--top-k",
    String(options.topK ?? runtimeOverrideEnv("MANGA_TRANSLATOR_TOP_K", options) ?? "64"),
    "--top-p",
    String(options.topP ?? runtimeOverrideEnv("MANGA_TRANSLATOR_TOP_P", options) ?? "0.95"),
    "--min-p",
    String(runtimeOverrideEnv("MANGA_TRANSLATOR_MIN_P", options) ?? "0.0"),
    "-rea",
    "off",
    "--reasoning-budget",
    "0",
    "-c",
    String(options.ctx),
    "-b",
    String(options.batch),
    "-ub",
    String(options.ubatch),
    "-np",
    "1",
    ...(useBeellamaGemmaLaunch ? [] : ["--no-cache-prompt", "--no-warmup"]),
    options.mmprojOffload === true ? "--mmproj-offload" : "--no-mmproj-offload",
    "--cache-ram",
    "0"
  ];

  if (useBeellamaGemmaLaunch) {
    args.push("--kv-unified", "--jinja", "--no-mmap", "--mlock");
    if (options.noHost !== false) {
      args.push("--no-host");
    }
  }
  if (typeof options.threads === "number" && Number.isFinite(options.threads) && options.threads > 0) {
    args.push("--threads", String(Math.round(options.threads)));
  }
  if (typeof options.threadsBatch === "number" && Number.isFinite(options.threadsBatch) && options.threadsBatch > 0) {
    args.push("--threads-batch", String(Math.round(options.threadsBatch)));
  }
  if (typeof options.poll === "number" && Number.isFinite(options.poll)) {
    args.push("--poll", String(Math.max(0, Math.min(100, Math.round(options.poll)))));
  }
  if (typeof options.pollBatch === "boolean") {
    args.push("--poll-batch", options.pollBatch ? "1" : "0");
  }
  if (typeof options.prioBatch === "number" && Number.isFinite(options.prioBatch)) {
    args.push("--prio-batch", String(Math.max(0, Math.min(3, Math.round(options.prioBatch)))));
  }
  if (typeof options.cacheIdleSlots === "boolean") {
    args.push(options.cacheIdleSlots ? "--cache-idle-slots" : "--no-cache-idle-slots");
  }
  if (typeof options.cacheReuse === "number" && Number.isFinite(options.cacheReuse) && options.cacheReuse >= 0) {
    args.push("--cache-reuse", String(Math.round(options.cacheReuse)));
  }
  if (options.enableMetrics === true) {
    args.push("--metrics");
  }
  if (typeof options.enablePerf === "boolean") {
    args.push(options.enablePerf ? "--perf" : "--no-perf");
  }

  if (options.cacheTypeK) {
    args.push("--cache-type-k", String(options.cacheTypeK));
  }
  if (options.cacheTypeV) {
    args.push("--cache-type-v", String(options.cacheTypeV));
  }
  if (options.kvOffload === false) {
    args.push("--no-kv-offload");
  } else if (options.kvOffload === true) {
    args.push("--kv-offload");
  }
  if (typeof options.ctxCheckpoints === "number" && Number.isFinite(options.ctxCheckpoints)) {
    args.push("--ctx-checkpoints", String(options.ctxCheckpoints));
  }

  if (typeof options.imageMinTokens === "number" && Number.isFinite(options.imageMinTokens)) {
    args.push("--image-min-tokens", String(options.imageMinTokens));
  }
  if (typeof options.imageMaxTokens === "number" && Number.isFinite(options.imageMaxTokens)) {
    args.push("--image-max-tokens", String(options.imageMaxTokens));
  }
  if (Array.isArray(options.extraArgs)) {
    for (const arg of options.extraArgs) {
      if (typeof arg === "string" && arg.trim()) {
        args.push(arg.trim());
      }
    }
  }
  args.push("--log-timestamps", "--log-prefix", "--log-colors", "off");

  return args;
}

function resolveDraftModelRepoArg(options = {}) {
  const repo = resolveConfiguredDraftModelRepo(options);
  const file = resolveConfiguredDraftModelFile(options);
  const quant = file.match(/-([A-Za-z0-9_]+)\.gguf$/)?.[1];
  return quant ? `${repo}:${quant}` : repo;
}

function shouldUseBeellamaGemmaLaunch(options = {}) {
  if (isGemma26BModel(options)) {
    return false;
  }
  const serverPath = String(options.serverPath || runtimeOverrideEnv("LLAMA_SERVER_PATH", options) || defaultServerPath(options) || "");
  const isBeellamaRuntime = /beellama/i.test(serverPath);
  const isGemma4Model = looksLikeGemma4Model(options);
  if (isBeellamaRuntime && isGemma4Model) {
    return true;
  }
  if (resolveConfiguredModelSource(options) === "local") {
    const localModelPath = resolveConfiguredLocalModelPath(options);
    return path.basename(localModelPath || "") === DEFAULT_HF_FILE;
  }
  return resolveConfiguredModelRepo(options) === DEFAULT_MODEL_HF || resolveConfiguredModelFile(options) === DEFAULT_HF_FILE;
}

function looksLikeGemma4Model(options = {}) {
  const parts = [
    resolveConfiguredModelRepo(options),
    resolveConfiguredModelFile(options),
    resolveConfiguredLocalModelPath(options),
    resolveConfiguredMmprojRepo(options),
    resolveConfiguredMmprojFile(options)
  ];
  return parts.some((part) => /gemma[-_]?4/i.test(String(part || "")));
}

function isServerRuntimeCompatibleWithModel(serverPath, options = {}) {
  if (!serverPath || !looksLikeGemma4Model(options)) {
    return true;
  }
  const text = String(serverPath);
  if (isGemma26BModel(options)) {
    return !/beellama/i.test(text);
  }
  if (isGemma31BModel(options)) {
    return /beellama/i.test(text);
  }
  return true;
}

module.exports = {
  buildLaunchArgs,
  isServerRuntimeCompatibleWithModel,
  looksLikeGemma4Model
};
