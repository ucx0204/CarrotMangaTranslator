const { spawn } = require("node:child_process");
const { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { copyFile, mkdir, open, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const { bundledServerCandidates, resolveBundledServerPath } = require("./resolve-llama-runtime.cjs");
const {
  CROP_RETRY_MARGIN_RATIO,
  CROP_RETRY_MIN_MARGIN_PX,
  CROP_RETRY_MIN_SIDE_PX,
  DEFAULT_API_KEY,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
  DEFAULT_HF_FILE,
  DEFAULT_MMPROJ_FILE,
  DEFAULT_MMPROJ_HF,
  DEFAULT_MODEL_HF,
  DEFAULT_OCR_BBOX_PAGE_TIMEOUT_MS,
  DEFAULT_OCR_BBOX_TIMEOUT_MS,
  DEFAULT_OCR_CPU_PIP_PACKAGES,
  DEFAULT_OCR_GPU_CUDA_TAG,
  DEFAULT_OCR_GPU_EXTRA_PACKAGES,
  DEFAULT_OCR_GPU_PADDLE_PACKAGE,
  HF_DOWNLOAD_CHUNK_SIZE,
  MAX_LOG_PREVIEW_LENGTH,
  MM_PROJ_CANDIDATE_NAMES,
  OCR_INSTALL_MARKER_FILE,
  PADDLE_OCR_MODEL_DOWNLOADS,
  PADDLEOCR_VL_WINDOWS_SAFETENSORS_WHEEL
} = require("./simple-page-defaults.cjs");
const {
  buildSystemPrompt,
  getOverlayPrompt,
  PROMPT_KO_BBOX_LINES_MULTIVIEW,
  readOcrCandidateText,
  readPositiveInteger,
  resolvePromptCoordinateFrame,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt
} = require("./simple-page-prompts.cjs");
const {
  extractJsonText,
  normalizeOcrBboxHintPayload
} = require("./simple-page-ocr-hints.cjs");
const {
  clampProgressRatio,
  createOcrBatchProgressFilePoller,
  formatBytes,
  formatPaddleModelFetchProgress,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  parsePipRawProgress,
  resolveOcrBboxTimeoutMs,
  sanitizeInstallLogLine
} = require("./simple-page-progress.cjs");
const {
  isOpenAICodexProvider,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveModelProvider,
  resolveProviderDisplayName
} = require("./simple-page-model-config.cjs");
const {
  calculateOpenAIOriginalDetailSize,
  enhanceBitmapBuffer,
  getScaledSize,
  mimeFromPath
} = require("./simple-page-image-utils.cjs");

const BEELLAMA_LLAMA_RUNTIME_CUDA12 = {
  id: "beellama-v0.2.0-cuda12.4",
  kind: "beellama",
  dir: "beellama-v0.2.0-cuda12.4",
  archive: "beellama-v0.2.0-bin-win-cuda-12.4-x64.zip",
  url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-12.4-x64.zip",
  archives: [
    {
      archive: "beellama-v0.2.0-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-12.4-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/cudart-llama-bin-win-cuda-12.4-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    ["ggml-cuda.dll", "ggml-cuda-cu12.dll"],
    ["cublas64_12.dll"],
    ["cublasLt64_12.dll"],
    ["cudart64_12.dll"]
  ]
};
const BEELLAMA_LLAMA_RUNTIME_CUDA13 = {
  id: "beellama-v0.2.0-cuda13.1",
  kind: "beellama",
  dir: "beellama-v0.2.0-cuda13.1",
  archive: "beellama-v0.2.0-bin-win-cuda-13.1-x64.zip",
  url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-13.1-x64.zip",
  archives: [
    {
      archive: "beellama-v0.2.0-bin-win-cuda-13.1-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/beellama-v0.2.0-bin-win-cuda-13.1-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.1-x64.zip",
      url: "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.2.0/cudart-llama-bin-win-cuda-13.1-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    ["ggml-cuda.dll", "ggml-cuda-cu13.dll"],
    ["cublas64_13.dll", "cublas64_12.dll"],
    ["cublasLt64_13.dll", "cublasLt64_12.dll"],
    ["cudart64_13.dll", "cudart64_12.dll"]
  ]
};
const MAINLINE_LLAMA_RUNTIME_CUDA12 = {
  id: "llama-b8833-cuda12.4",
  kind: "mainline",
  dir: "llama-b8833-cuda12.4",
  archive: "llama-b8833-bin-win-cuda-12.4-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b8833/llama-b8833-bin-win-cuda-12.4-x64.zip",
  archives: [
    {
      archive: "llama-b8833-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b8833/llama-b8833-bin-win-cuda-12.4-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b8833/cudart-llama-bin-win-cuda-12.4-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    ["ggml-cuda.dll", "ggml-cuda-cu12.dll"],
    ["cublas64_12.dll"],
    ["cublasLt64_12.dll"],
    ["cudart64_12.dll"]
  ]
};
const MAINLINE_LLAMA_RUNTIME_CUDA13 = {
  id: "llama-b9490-cuda13.3",
  kind: "mainline",
  dir: "llama-b9490-cuda13.3",
  archive: "llama-b9490-bin-win-cuda-13.3-x64.zip",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b9490/llama-b9490-bin-win-cuda-13.3-x64.zip",
  archives: [
    {
      archive: "llama-b9490-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9490/llama-b9490-bin-win-cuda-13.3-x64.zip"
    },
    {
      archive: "cudart-llama-bin-win-cuda-13.3-x64.zip",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b9490/cudart-llama-bin-win-cuda-13.3-x64.zip"
    }
  ],
  requiredFiles: [
    "llama-server.exe",
    "llama-server-impl.dll",
    ["ggml-cuda.dll", "ggml-cuda-cu13.dll"],
    ["cublas64_13.dll", "cublas64_12.dll"],
    ["cublasLt64_13.dll", "cublasLt64_12.dll"],
    ["cudart64_13.dll", "cudart64_12.dll"]
  ]
};
const LLAMA_RUNTIME_MARKER_FILE = ".mgt-runtime.json";
const LLAMA_RUNTIME_FILES = new Set([
  "LICENSE",
  "cublas64_12.dll",
  "cublas64_13.dll",
  "cublasLt64_12.dll",
  "cublasLt64_13.dll",
  "cudart64_12.dll",
  "cudart64_13.dll",
  "ggml-base.dll",
  "ggml-cpu.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-cascadelake.dll",
  "ggml-cpu-cooperlake.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-ivybridge.dll",
  "ggml-cpu-piledriver.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-sapphirerapids.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll",
  "ggml-cpu-zen4.dll",
  "ggml-cuda.dll",
  "ggml-cuda-cu12.dll",
  "ggml-cuda-cu13.dll",
  "ggml-rpc.dll",
  "ggml.dll",
  "libomp140.x86_64.dll",
  "llama-common.dll",
  "llama-server-impl.dll",
  "llama-server.exe",
  "llama.dll",
  "mtmd.dll",
  "rpc-server.exe"
]);

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function truncateText(value, maxLength = MAX_LOG_PREVIEW_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function createDetailedError(message, detail = {}, cause) {
  const error = new Error(message);
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}

const BASE_CHILD_ENV_KEYS = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "HOME",
  "LANG",
  "LC_ALL"
];

const NETWORK_CHILD_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE"
];

const HF_CHILD_ENV_KEYS = [
  "HF_ENDPOINT",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN"
];

function shouldAllowExternalRuntimeOverrides(options = {}) {
  if (!isLikelyPackagedToolsDir(options.toolsDir)) {
    return true;
  }
  return isTruthy(process.env.MGT_ALLOW_EXTERNAL_RUNTIME ?? process.env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME);
}

function runtimeOverrideEnv(name, options = {}) {
  return shouldAllowExternalRuntimeOverrides(options) ? process.env[name] : undefined;
}

function buildWhitelistedChildEnv({ pathDirs = [], includeProcessPath = false, extraKeys = [] } = {}) {
  const env = {};
  for (const key of [...BASE_CHILD_ENV_KEYS, ...extraKeys]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  const runtimePath = buildChildPathEnv(pathDirs, includeProcessPath);
  if (runtimePath) {
    env.PATH = runtimePath;
  }
  return env;
}

function buildUtilityChildEnv(options = {}, pathDirs = []) {
  return buildWhitelistedChildEnv({
    pathDirs,
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: NETWORK_CHILD_ENV_KEYS
  });
}

function buildChildPathEnv(pathDirs = [], includeProcessPath = false) {
  const dirs = [];
  const addDir = (dir) => {
    const text = String(dir ?? "").trim();
    if (!text) {
      return;
    }
    const normalized = process.platform === "win32" ? text.toLowerCase() : text;
    if (!dirs.some((candidate) => (process.platform === "win32" ? candidate.toLowerCase() : candidate) === normalized)) {
      dirs.push(text);
    }
  };

  for (const dir of pathDirs) {
    addDir(dir);
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    addDir(systemRoot ? path.join(systemRoot, "System32") : null);
    addDir(systemRoot);
    addDir(systemRoot ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0") : null);
  }
  if (includeProcessPath) {
    for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
      addDir(dir);
    }
  }
  return dirs.join(path.delimiter);
}

function buildOptionSummary(options = {}) {
  const launchTarget = inspectModelLaunch(options);
  return {
    label: options.label,
    imagePath: options.imagePath,
    outputDir: options.outputDir,
    modelProvider: resolveModelProvider(options),
    port: options.port,
    promptMode: options.promptMode,
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    maxTokens: options.maxTokens,
    ctx: options.ctx,
    batch: options.batch,
    ubatch: options.ubatch,
    gemmaVramMode: options.gemmaVramMode,
    fitTargetMb: options.fitTargetMb,
    cacheTypeK: options.cacheTypeK,
    cacheTypeV: options.cacheTypeV,
    ctxCheckpoints: options.ctxCheckpoints,
    kvOffload: options.kvOffload,
    mmprojOffload: options.mmprojOffload,
    threads: options.threads,
    threadsBatch: options.threadsBatch,
    poll: options.poll,
    pollBatch: options.pollBatch,
    prioBatch: options.prioBatch,
    cacheIdleSlots: options.cacheIdleSlots,
    cacheReuse: options.cacheReuse,
    enableMetrics: options.enableMetrics,
    enablePerf: options.enablePerf,
    useDraft: Boolean(options.useDraft),
    draftModelRepo: resolveConfiguredDraftModelRepo(options),
    draftModelFile: resolveConfiguredDraftModelFile(options),
    imageMinTokens: options.imageMinTokens,
    imageMaxTokens: options.imageMaxTokens,
    includeEnhancedVariant: options.includeEnhancedVariant,
    enhancedMaxLongSide: options.enhancedMaxLongSide,
    enhancedContrast: options.enhancedContrast,
    imageFirst: options.imageFirst,
    reuseServer: options.reuseServer,
    llamaRuntimeProfile: options.llamaRuntimeProfile,
    workingDir: options.workingDir,
    toolsDir: options.toolsDir,
    serverPath: options.serverPath,
    modelSource: resolveConfiguredModelSource(options),
    modelRepo: options.modelRepo,
    modelFile: options.modelFile,
    mmprojRepo: resolveConfiguredMmprojRepo(options),
    mmprojFile: resolveConfiguredMmprojFile(options),
    mmprojUrl: resolveConfiguredMmprojUrl(options),
    draftModelPath: launchTarget.draftModelPath ?? null,
    draftModelUrl: launchTarget.draftModelUrl ?? null,
    localModelPath: resolveConfiguredLocalModelPath(options),
    localMmprojPath: resolveConfiguredLocalMmprojPath(options),
    codexModel: resolveConfiguredCodexModel(options),
    codexReasoningEffort: resolveConfiguredCodexReasoningEffort(options),
    codexOauthPort: options.codexOauthPort,
    ocrBboxProvider: resolveOcrBboxProvider(options),
    ocrDevice: resolveOcrDevice(options),
    ocrGpuCudaTag: resolveOcrGpuCudaTag(options),
    ocrRuntimeDir: resolveOcrRuntimeDir(options),
    launchMode: launchTarget.launchMode,
    hfHomeDir: resolveHfHomeDir(options),
    hfHubCacheDir: resolveHubCacheDir(options)
  };
}

function summarizeImageVariants(imageVariants) {
  return imageVariants.map((variant) => ({
    role: variant.role,
    path: variant.path,
    mime: variant.mime || mimeFromPath(variant.path),
    convertedFromMime: variant.convertedFromMime || null,
    width: variant.width || null,
    height: variant.height || null,
    originalWidth: variant.originalWidth || null,
    originalHeight: variant.originalHeight || null
  }));
}

function buildRequestSummary(server, options, imageVariants, promptText, systemPrompt) {
  const coordinateFrame = resolvePromptCoordinateFrame(options, imageVariants);
  const ocrBboxHints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  return {
    endpoint: `${server.baseUrl}/${isOpenAICodexProvider(options) ? "responses" : "chat/completions"}`,
    model: resolveRequestModelName(options),
    label: options.label,
    promptMode: options.promptMode,
    promptPreview: truncateText(promptText, 2400),
    systemPromptPreview: truncateText(systemPrompt, 2400),
    imageVariants: summarizeImageVariants(imageVariants),
    bboxCoordinateSpace: coordinateFrame.space,
    bboxCoordinateFrame: coordinateFrame.frame,
    ocrBboxHintCount: ocrBboxHints.length,
    ocrBboxHints: ocrBboxHints.slice(0, 80).map((hint) => ({
      id: hint.id,
      label: hint.label,
      x1: hint.x1,
      y1: hint.y1,
      x2: hint.x2,
      y2: hint.y2,
      score: hint.score ?? null,
      ocrText: truncateText(readOcrCandidateText(hint), 160) || null
    })),
    ocrBboxHintsPreview: ocrBboxHints.slice(0, 24).map((hint) => ({
      id: hint.id,
      label: hint.label,
      x1: hint.x1,
      y1: hint.y1,
      x2: hint.x2,
      y2: hint.y2,
      score: hint.score ?? null,
      ocrText: truncateText(readOcrCandidateText(hint), 160) || null
    })),
    options: buildOptionSummary(options)
  };
}

function buildEnhancedVariantFailureDetail(error, options = {}) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      imagePath: options.imagePath,
      format: path.extname(options.imagePath || "").toLowerCase() || null,
      reason: "enhanced-variant-unavailable",
      cause: error.cause
    };
  }

  return {
    name: "Error",
    message: String(error),
    imagePath: options.imagePath,
    format: path.extname(options.imagePath || "").toLowerCase() || null,
    reason: "enhanced-variant-unavailable"
  };
}

function resolveElectronNativeImage() {
  try {
    const electronModule = require("electron");
    if (
      electronModule &&
      typeof electronModule === "object" &&
      electronModule.nativeImage &&
      typeof electronModule.nativeImage.createFromPath === "function"
    ) {
      return electronModule.nativeImage;
    }
  } catch {
    // Ignore node-only contexts and fall back to the PowerShell pipeline.
  }

  return null;
}

function resolveToolsDir(options = {}) {
  const candidates = [
    options.toolsDir,
    runtimeOverrideEnv("MANGA_TRANSLATOR_TOOLS_DIR", options),
    path.resolve(__dirname, "..", "tools"),
    path.resolve(__dirname, "..", "..", "tools")
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function resolveManagedToolsDir(options = {}) {
  const explicit = String(options.managedToolsDir ?? runtimeOverrideEnv("MANGA_TRANSLATOR_MANAGED_TOOLS_DIR", options) ?? "").trim();
  if (explicit) {
    return explicit;
  }
  return path.join(resolveWorkingDir(options), "tools");
}

function resolveLlamaRuntimeSearchDirs(options = {}) {
  const dirs = [
    resolveManagedToolsDir(options),
    resolveToolsDir(options)
  ];
  const seen = new Set();
  return dirs.filter((dir) => {
    if (!dir) {
      return false;
    }
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function defaultServerPath(options = {}) {
  const dirs = resolveLlamaRuntimeSearchDirs(options);
  const existingCandidates = dirs.flatMap((dir) => bundledServerCandidates(dir).filter((candidate) => existsSync(candidate)));
  const preferredRuntime = resolvePreferredLlamaRuntime(options);
  const preferredCandidate = existingCandidates.find((candidate) => isRuntimeCandidate(candidate, preferredRuntime));
  if (preferredCandidate) {
    return preferredCandidate;
  }
  const preferredManagedPath = path.join(resolveManagedToolsDir(options), preferredRuntime.dir, serverBinaryName());
  if (isBuiltInGemmaRuntimeModel(options)) {
    return preferredManagedPath;
  }
  if (!existsSync(preferredManagedPath)) {
    return preferredManagedPath;
  }
  return (
    existingCandidates.find((candidate) => hasCudaRuntimeBackend(path.dirname(candidate))) ||
    existingCandidates[0] ||
    resolveBundledServerPath(dirs[0] || resolveToolsDir(options))
  );
}

function serverBinaryName() {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

function hasCudaRuntimeBackend(runtimeDir) {
  try {
    return ["ggml-cuda.dll", "ggml-cuda-cu12.dll", "ggml-cuda-cu13.dll"].some((fileName) => existsSync(path.join(runtimeDir, fileName)));
  } catch {
    return false;
  }
}

function hasRequiredLlamaRuntimeFiles(runtimeDir, runtime) {
  if (!runtimeDir || !runtime) {
    return false;
  }
  try {
    for (const requirement of runtime.requiredFiles || [serverBinaryName()]) {
      const candidates = Array.isArray(requirement) ? requirement : [requirement];
      if (!candidates.some((fileName) => existsSync(path.join(runtimeDir, fileName)))) {
        return false;
      }
    }
    return hasCudaRuntimeBackend(runtimeDir);
  } catch {
    return false;
  }
}

function missingRequiredLlamaRuntimeFiles(runtimeDir, runtime) {
  const missing = [];
  for (const requirement of runtime?.requiredFiles || [serverBinaryName()]) {
    const candidates = Array.isArray(requirement) ? requirement : [requirement];
    if (!candidates.some((fileName) => existsSync(path.join(runtimeDir, fileName)))) {
      missing.push(candidates.join(" | "));
    }
  }
  if (!hasCudaRuntimeBackend(runtimeDir)) {
    missing.push("ggml-cuda.dll | ggml-cuda-cu12.dll | ggml-cuda-cu13.dll");
  }
  return missing;
}

function isRuntimeCandidate(serverPath, runtime) {
  try {
    const runtimeDir = path.dirname(serverPath);
    return path.basename(runtimeDir).toLowerCase() === runtime.dir.toLowerCase() && hasRequiredLlamaRuntimeFiles(runtimeDir, runtime);
  } catch {
    return false;
  }
}

function resolvePreferredLlamaRuntime(options = {}) {
  const rtx50Runtime = shouldUseRtx50LlamaRuntime(options);
  if (isGemma26BModel(options)) {
    return rtx50Runtime ? MAINLINE_LLAMA_RUNTIME_CUDA13 : MAINLINE_LLAMA_RUNTIME_CUDA12;
  }
  return rtx50Runtime ? BEELLAMA_LLAMA_RUNTIME_CUDA13 : BEELLAMA_LLAMA_RUNTIME_CUDA12;
}

function shouldUseRtx50LlamaRuntime(options = {}) {
  const profile = String(options.llamaRuntimeProfile ?? runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE", options) ?? "").trim().toLowerCase();
  if (["rtx50", "blackwell", "cuda13", "cuda13.1", "cuda13.3"].includes(profile)) {
    return true;
  }
  if (["default", "cuda12", "cuda12.4", "legacy"].includes(profile)) {
    return false;
  }
  const cudaTag = String(options.ocrGpuCudaTag ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", options) ?? "").trim().toLowerCase();
  return cudaTag === "cu129" || cudaTag === "cu13" || cudaTag === "cu131" || cudaTag === "cu133";
}

function isGemma26BModel(options = {}) {
  const parts = [
    resolveConfiguredModelRepo(options),
    resolveConfiguredModelFile(options),
    resolveConfiguredLocalModelPath(options),
    resolveConfiguredMmprojRepo(options),
    resolveConfiguredMmprojFile(options)
  ];
  return parts.some((part) => /gemma[-_]?4[-_]?26b/i.test(String(part || "")));
}

function isGemma31BModel(options = {}) {
  const parts = [
    resolveConfiguredModelRepo(options),
    resolveConfiguredModelFile(options),
    resolveConfiguredLocalModelPath(options),
    resolveConfiguredMmprojRepo(options),
    resolveConfiguredMmprojFile(options)
  ];
  return parts.some((part) => /gemma[-_]?4[-_]?31b/i.test(String(part || "")));
}

function isBuiltInGemmaRuntimeModel(options = {}) {
  return isGemma26BModel(options) || isGemma31BModel(options);
}

function bundledFfmpegCandidates(toolsDir) {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return [
    path.join(toolsDir || "", "ffmpeg", binaryName),
    path.join(toolsDir || "", "ffmpeg", "bin", binaryName),
    path.join(toolsDir || "", binaryName)
  ];
}

function resolveFfmpegPath(options = {}) {
  const toolsDir = resolveToolsDir(options);
  const bundledCandidates = bundledFfmpegCandidates(toolsDir);
  const bundledPath = bundledCandidates.find((candidate) => existsSync(candidate));
  if (bundledPath) {
    return bundledPath;
  }

  if (isLikelyPackagedToolsDir(toolsDir)) {
    throw createDetailedError("Bundled ffmpeg is missing from the packaged tools directory.", {
      toolsDir,
      candidatePaths: bundledCandidates,
      command: "ffmpeg"
    });
  }

  const explicitCandidates = [
    options.ffmpegPath,
    runtimeOverrideEnv("MANGA_TRANSLATOR_FFMPEG_PATH", options)
  ].filter(Boolean);
  const explicitPath = explicitCandidates.find((candidate) => existsSync(candidate));
  if (explicitPath) {
    return explicitPath;
  }

  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function resolveWorkingDir(options = {}) {
  return options.workingDir || process.cwd();
}

function resolveHfHomeDir(options = {}) {
  return (
    options.hfHomeDir ||
    runtimeOverrideEnv("HF_HOME", options) ||
    runtimeOverrideEnv("MANGA_TRANSLATOR_HF_HOME", options) ||
    defaultHfHomeDir()
  );
}

function resolveHubCacheDir(options = {}) {
  const hfHomeDir = resolveHfHomeDir(options);
  return (
    options.hfHubCacheDir ||
    runtimeOverrideEnv("HF_HUB_CACHE", options) ||
    runtimeOverrideEnv("HUGGINGFACE_HUB_CACHE", options) ||
    (hfHomeDir ? path.join(hfHomeDir, "hub") : null)
  );
}

function defaultHfHomeDir() {
  const xdgCacheHome = String(process.env.XDG_CACHE_HOME ?? "").trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "huggingface");
  }

  const homeDir = String(process.env.USERPROFILE ?? process.env.HOME ?? "").trim();
  if (!homeDir) {
    return null;
  }

  return path.join(homeDir, ".cache", "huggingface");
}

function resolveLlamaCppCacheDir(options = {}) {
  const explicit = String(options.llamaCacheDir ?? runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_CACHE_DIR", options) ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (process.platform === "win32") {
    const localAppData = String(process.env.LOCALAPPDATA ?? "").trim();
    return localAppData ? path.join(localAppData, "manga-gemma-translator", "llama.cpp") : null;
  }
  const xdgCacheHome = String(process.env.XDG_CACHE_HOME ?? "").trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "manga-gemma-translator", "llama.cpp");
  }
  const homeDir = String(process.env.HOME ?? "").trim();
  return homeDir ? path.join(homeDir, ".cache", "manga-gemma-translator", "llama.cpp") : null;
}

function repoCacheDir(repoId, hubCacheDir) {
  return path.join(hubCacheDir, `models--${repoId.replace(/\//g, "--")}`);
}

function safeMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function findNamedFile(rootDir, expectedName, maxDepth = 6) {
  if (!rootDir || !existsSync(rootDir)) {
    return null;
  }

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = readdirSync(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name === expectedName) {
        return fullPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function findMatchingFile(rootDir, predicate, maxDepth = 6) {
  if (!rootDir || !existsSync(rootDir)) {
    return null;
  }

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = readdirSync(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && predicate(entry.name, fullPath)) {
        return fullPath;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

function listSnapshotDirs(repoDir) {
  const snapshotsDir = path.join(repoDir, "snapshots");
  if (!existsSync(snapshotsDir)) {
    return [];
  }

  return readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(snapshotsDir, entry.name))
    .sort((left, right) => safeMtimeMs(right) - safeMtimeMs(left) || right.localeCompare(left));
}

function findPreferredMmprojFile(rootDir) {
  for (const candidateName of MM_PROJ_CANDIDATE_NAMES) {
    const match = findNamedFile(rootDir, candidateName, 2);
    if (match) {
      return match;
    }
  }

  return findMatchingFile(rootDir, (name) => /^mmproj.*\.gguf$/i.test(name), 2);
}

function resolveConfiguredMmprojRepo(options = {}) {
  return String(options.mmprojRepo ?? process.env.MANGA_TRANSLATOR_MMPROJ_HF ?? "").trim() || DEFAULT_MMPROJ_HF;
}

function resolveConfiguredMmprojFile(options = {}) {
  return String(options.mmprojFile ?? process.env.LLAMA_ARG_MMPROJ_FILE ?? "").trim() || DEFAULT_MMPROJ_FILE;
}

function shouldUseConfiguredMmproj(options = {}) {
  const explicitRepo = String(options.mmprojRepo ?? process.env.MANGA_TRANSLATOR_MMPROJ_HF ?? "").trim();
  const explicitFile = String(options.mmprojFile ?? process.env.LLAMA_ARG_MMPROJ_FILE ?? "").trim();
  if (explicitRepo || explicitFile) {
    return true;
  }
  return resolveConfiguredModelRepo(options) === DEFAULT_MODEL_HF;
}

function resolveConfiguredMmprojUrl(options = {}) {
  if (!shouldUseConfiguredMmproj(options)) {
    return null;
  }
  const repo = resolveConfiguredMmprojRepo(options);
  const file = resolveConfiguredMmprojFile(options);
  if (!repo || !file) {
    return null;
  }
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

function resolveCachedConfiguredMmprojPath(options = {}) {
  if (!shouldUseConfiguredMmproj(options)) {
    return null;
  }
  const configuredFile = resolveConfiguredMmprojFile(options);
  const hubCacheDir = resolveHubCacheDir(options);
  if (hubCacheDir) {
    const repoDir = repoCacheDir(resolveConfiguredMmprojRepo(options), hubCacheDir);
    if (existsSync(repoDir)) {
      for (const snapshotDir of listSnapshotDirs(repoDir)) {
        const mmprojPath = path.join(snapshotDir, configuredFile);
        if (existsSync(mmprojPath)) {
          return mmprojPath;
        }
      }
      const namedMatch = findNamedFile(repoDir, configuredFile);
      if (namedMatch) {
        return namedMatch;
      }
    }
  }
  return resolveCachedLlamaCppFile(configuredFile, options);
}

function resolveCachedLlamaCppFile(fileName, options = {}) {
  const cacheDir = resolveLlamaCppCacheDir(options);
  if (!cacheDir || !fileName || !existsSync(cacheDir)) {
    return null;
  }
  const directPath = path.join(cacheDir, fileName);
  if (existsSync(directPath)) {
    return directPath;
  }
  return findNamedFile(cacheDir, fileName, 2);
}

function resolveConfiguredDraftModelRepo(options = {}) {
  return String(options.draftModelRepo ?? process.env.MANGA_TRANSLATOR_DRAFT_MODEL_HF ?? "").trim();
}

function resolveConfiguredDraftModelFile(options = {}) {
  return String(options.draftModelFile ?? process.env.MANGA_TRANSLATOR_DRAFT_MODEL_FILE ?? "").trim();
}

function resolveConfiguredDraftModelUrl(options = {}) {
  const repo = resolveConfiguredDraftModelRepo(options);
  const file = resolveConfiguredDraftModelFile(options);
  if (!repo || !file) {
    return null;
  }
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

function resolveManagedHfFilePath(options = {}, repo, file) {
  const hubCacheDir = resolveHubCacheDir(options);
  if (!hubCacheDir || !repo || !file) {
    return null;
  }
  return path.join(repoCacheDir(repo, hubCacheDir), "snapshots", "mgt-managed", safeHfRelativePath(file));
}

function safeHfRelativePath(file) {
  const normalized = String(file ?? "").replace(/\\/g, "/").trim();
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid Hugging Face file path: ${file}`);
  }
  return normalized.split("/").join(path.sep);
}

function collectRequiredHfDownloads(options = {}, launchTarget = inspectModelLaunch(options)) {
  if (launchTarget.launchMode === "openai-codex") {
    return [];
  }

  const tasks = [];
  if (launchTarget.launchMode !== "local" && !launchTarget.modelPath) {
    const repo = resolveConfiguredModelRepo(options);
    const file = resolveConfiguredModelFile(options);
    const url = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
    const destination = resolveManagedHfFilePath(options, repo, file);
    if (repo && file && destination) {
      tasks.push({ kind: "model", label: "Gemma 모델", repo, file, url, destination });
    }
  }

  if (launchTarget.mmprojUrl && !launchTarget.mmprojPath) {
    const repo = resolveConfiguredMmprojRepo(options);
    const file = resolveConfiguredMmprojFile(options);
    const destination = resolveManagedHfFilePath(options, repo, file);
    if (repo && file && destination) {
      tasks.push({ kind: "mmproj", label: "Gemma vision mmproj", repo, file, url: launchTarget.mmprojUrl, destination });
    }
  }

  if (options.useDraft && launchTarget.draftModelUrl && !launchTarget.draftModelPath) {
    const repo = resolveConfiguredDraftModelRepo(options);
    const file = resolveConfiguredDraftModelFile(options);
    const destination = resolveManagedHfFilePath(options, repo, file);
    if (repo && file && destination) {
      tasks.push({ kind: "draft", label: "Gemma draft 모델", repo, file, url: launchTarget.draftModelUrl, destination });
    }
  }

  return tasks;
}

async function ensureHfModelAssetsDownloaded(options = {}, launchTarget = inspectModelLaunch(options)) {
  const tasks = collectRequiredHfDownloads(options, launchTarget).filter((task) => !isUsableFile(task.destination));
  if (tasks.length === 0) {
    return;
  }

  let knownTotalBytes = 0;
  const totals = new Map();
  for (const task of tasks) {
    const totalBytes = await probeContentLength(task.url, options.abortSignal);
    if (Number.isFinite(totalBytes) && totalBytes > 0) {
      totals.set(task.destination, totalBytes);
      knownTotalBytes += totalBytes;
    }
  }

  const hasKnownAggregate = knownTotalBytes > 0 && totals.size === tasks.length;
  let completedBytes = 0;
  emitRuntimeProgress(options, "model_downloading", "Gemma 모델 다운로드 중", `${tasks.length}개 파일 준비`, {
    progressMode: hasKnownAggregate ? "determinate" : "log-only",
    progressPercent: hasKnownAggregate ? 0 : undefined,
    progressBytes: 0,
    progressTotalBytes: hasKnownAggregate ? knownTotalBytes : undefined,
    installLogLine: `다운로드 대상 ${tasks.length}개 파일을 확인했습니다.`
  });

  for (const task of tasks) {
    const totalBytes = totals.get(task.destination) || 0;
    await downloadHfFileWithProgress(task, options, {
      totalBytes,
      knownAggregateBytes: hasKnownAggregate ? knownTotalBytes : 0,
      completedBytes,
      onComplete: (bytesWritten) => {
        completedBytes += hasKnownAggregate ? totalBytes : bytesWritten;
      }
    });
  }

  emitRuntimeProgress(options, "model_downloading", "Gemma 모델 다운로드 완료", "모든 모델 파일을 로컬 캐시에 저장했습니다.", {
    progressMode: hasKnownAggregate ? "determinate" : "log-only",
    progressPercent: hasKnownAggregate ? 1 : undefined,
    progressBytes: hasKnownAggregate ? knownTotalBytes : undefined,
    progressTotalBytes: hasKnownAggregate ? knownTotalBytes : undefined,
    installLogLine: "Gemma 모델 파일 다운로드가 완료되었습니다."
  });
}

async function ensureDefaultLlamaRuntimeDownloaded(options = {}) {
  const runtime = resolvePreferredLlamaRuntime(options);
  const managedToolsDir = resolveManagedToolsDir(options);
  const runtimeDir = path.join(managedToolsDir, runtime.dir);
  const serverPath = path.join(runtimeDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
  if (isCurrentLlamaRuntime(runtimeDir, runtime) && hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)) {
    return;
  }

  if (process.platform !== "win32") {
    throw createDetailedError("Bundled llama-server binary is missing.", {
      serverPath,
      toolsDir: resolveToolsDir(options),
      managedToolsDir,
      checkedServerPaths: resolveLlamaRuntimeSearchDirs(options).flatMap((dir) => bundledServerCandidates(dir))
    });
  }

  const downloadsDir = path.join(managedToolsDir, ".downloads");
  const archives = getLlamaRuntimeArchives(runtime);
  const archiveTotals = new Map();
  let knownAggregateBytes = 0;
  for (const archive of archives) {
    const totalBytes = await probeContentLength(archive.url, options.abortSignal);
    if (Number.isFinite(totalBytes) && totalBytes > 0) {
      archiveTotals.set(archive.archive, totalBytes);
      knownAggregateBytes += totalBytes;
    }
  }
  const hasKnownAggregate = knownAggregateBytes > 0 && archiveTotals.size === archives.length;
  let completedBytes = 0;
  const archivePaths = [];
  for (const archive of archives) {
    const archivePath = path.join(downloadsDir, archive.archive);
    archivePaths.push(archivePath);
    const totalBytes = archiveTotals.get(archive.archive) || 0;
    await downloadHfFileWithProgress(
      {
        kind: "llama-runtime",
        label: `Gemma 실행 런타임 (${runtime.kind})`,
        file: archive.archive,
        url: archive.url,
        destination: archivePath,
        progressPhase: "model_downloading",
        progressTitle: "Gemma 실행 런타임 다운로드 중",
        completeTitle: "Gemma 실행 런타임 다운로드 완료"
      },
      options,
      {
        totalBytes,
        knownAggregateBytes: hasKnownAggregate ? knownAggregateBytes : 0,
        completedBytes,
        onComplete: (bytesWritten) => {
          completedBytes += hasKnownAggregate ? totalBytes : bytesWritten;
        }
      }
    );
  }

  emitRuntimeProgress(options, "model_downloading", "Gemma 실행 런타임 설치 중", runtime.dir, {
    progressMode: "indeterminate",
    installLogLine: "Gemma 실행 파일과 CUDA DLL을 앱 데이터 폴더에 풀고 있습니다."
  });
  await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(runtimeDir, { recursive: true });
  for (const archivePath of archivePaths) {
    await extractSelectedZipEntries(archivePath, runtimeDir, shouldExtractLlamaRuntimeFile);
  }

  const missingFiles = missingRequiredLlamaRuntimeFiles(runtimeDir, runtime);
  if (missingFiles.length > 0) {
    throw createDetailedError("Gemma 실행 런타임을 설치했지만 필수 실행 파일 또는 CUDA DLL을 찾지 못했습니다.", {
      archives: archivePaths,
      runtimeDir,
      serverPath,
      missingFiles
    });
  }
  await writeFile(path.join(runtimeDir, LLAMA_RUNTIME_MARKER_FILE), `${JSON.stringify({
    id: runtime.id,
    kind: runtime.kind,
    dir: runtime.dir,
    archives,
    requiredFiles: runtime.requiredFiles,
    installedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  emitRuntimeProgress(options, "model_downloading", "Gemma 실행 런타임 설치 완료", runtime.dir, {
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Gemma 실행 런타임 준비가 완료되었습니다."
  });
}

function isCurrentLlamaRuntime(runtimeDir, runtime = resolvePreferredLlamaRuntime({})) {
  try {
    const marker = JSON.parse(readFileSync(path.join(runtimeDir, LLAMA_RUNTIME_MARKER_FILE), "utf8"));
    const expectedArchives = getLlamaRuntimeArchives(runtime);
    const markerArchives = Array.isArray(marker?.archives) ? marker.archives : [];
    return (
      marker?.id === runtime.id &&
      marker?.kind === runtime.kind &&
      marker?.dir === runtime.dir &&
      expectedArchives.every((archive) =>
        markerArchives.some((candidate) => candidate?.archive === archive.archive && candidate?.url === archive.url)
      )
    );
  } catch {
    return false;
  }
}

function getLlamaRuntimeArchives(runtime) {
  if (Array.isArray(runtime?.archives) && runtime.archives.length > 0) {
    return runtime.archives;
  }
  return runtime?.archive && runtime?.url ? [{ archive: runtime.archive, url: runtime.url }] : [];
}

function shouldExtractLlamaRuntimeFile(fileName) {
  return LLAMA_RUNTIME_FILES.has(fileName) || /\.dll$/i.test(String(fileName ?? ""));
}

async function extractSelectedZipEntries(archivePath, outputDir, shouldExtract) {
  const extractDir = path.join(path.dirname(outputDir), `${path.basename(outputDir)}.extract-${process.pid}-${Date.now()}`);
  await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(extractDir, { recursive: true });
  try {
    await expandZipArchive(archivePath, extractDir);
    const selectedFiles = collectSelectedFiles(extractDir, shouldExtract);
    if (selectedFiles.length === 0) {
      throw new Error(`No runtime files matched in ${archivePath}`);
    }
    for (const filePath of selectedFiles) {
      const fileName = path.basename(filePath);
      const outputPath = path.join(outputDir, fileName);
      if (!path.resolve(outputPath).startsWith(path.resolve(outputDir))) {
        throw new Error(`Invalid runtime output path: ${fileName}`);
      }
      await copyFile(filePath, outputPath);
    }
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function expandZipArchive(archivePath, outputDir) {
  if (process.platform !== "win32") {
    throw new Error("Default Gemma runtime auto-install is only supported on Windows.");
  }
  const psScript = "& { param($zip, $dest) Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }";
  await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript, archivePath, outputDir],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: buildUtilityChildEnv({})
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 4000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 4000);
    });
    child.on("error", (error) => {
      reject(createDetailedError("Failed to launch Expand-Archive.", {
        archivePath,
        outputDir,
        stdout: truncateText(stdout, 4000),
        stderr: truncateText(stderr, 4000)
      }, error));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(createDetailedError(`Expand-Archive failed (${code ?? "null"}).`, {
        archivePath,
        outputDir,
        stdout: truncateText(stdout.trim(), 4000),
        stderr: truncateText(stderr.trim(), 4000)
      }));
    });
  });
}

function collectSelectedFiles(rootDir, shouldExtract) {
  const selected = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (entry.isFile() && shouldExtract(entry.name)) {
        selected.push(filePath);
      }
    }
  }
  return selected;
}

function collectRequiredPaddleOcrModelDownloads(options = {}, runtime = null) {
  const runtimeDir = runtime?.runtimeDir || resolveOcrRuntimeDir(options);
  const endpoint = String(runtimeOverrideEnv("PADDLE_PDX_HUGGING_FACE_ENDPOINT", options) || "https://huggingface.co").replace(/\/+$/, "");
  const tasks = [];
  for (const model of PADDLE_OCR_MODEL_DOWNLOADS) {
    const modelDir = resolvePaddleOcrModelCacheDir(runtimeDir, model.name);
    for (const file of model.files) {
      tasks.push({
        kind: "paddle-ocr-model",
        label: `Paddle OCR ${model.name}`,
        repo: model.repo,
        file,
        url: buildHfResolveUrl(endpoint, model.repo, file),
        destination: path.join(modelDir, safeHfRelativePath(file)),
        progressPhase: "ocr_downloading",
        progressTitle: "Paddle OCR 모델 파일 다운로드 중",
        completeTitle: "Paddle OCR 모델 파일 다운로드 완료"
      });
    }
  }
  return tasks;
}

async function ensurePaddleOcrModelAssetsDownloaded(options = {}, runtime = null) {
  if (isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_SKIP_PADDLE_MODEL_PREFETCH", options) ?? "false")) {
    return;
  }

  const allTasks = collectRequiredPaddleOcrModelDownloads(options, runtime);
  const pending = [];
  const totals = new Map();
  let knownTotalBytes = 0;

  for (const task of allTasks) {
    const totalBytes = await probeContentLength(task.url, options.abortSignal);
    const existingSize = getFileSize(task.destination);
    if (totalBytes > 0 && existingSize === totalBytes) {
      continue;
    }
    if (totalBytes <= 0 && existingSize > 0) {
      continue;
    }
    if (existingSize > 0 && totalBytes > 0 && existingSize !== totalBytes) {
      await rm(task.destination, { force: true }).catch(() => {});
    }
    pending.push(task);
    if (totalBytes > 0) {
      totals.set(task.destination, totalBytes);
      knownTotalBytes += totalBytes;
    }
  }

  if (pending.length === 0) {
    return;
  }

  const hasKnownAggregate = knownTotalBytes > 0 && totals.size === pending.length;
  let completedBytes = 0;
  emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 모델 파일 다운로드 중", `${pending.length}개 파일 준비`, {
    progressMode: hasKnownAggregate ? "determinate" : "log-only",
    progressPercent: hasKnownAggregate ? 0 : undefined,
    progressBytes: 0,
    progressTotalBytes: hasKnownAggregate ? knownTotalBytes : undefined,
    installLogLine: `Paddle OCR 모델 다운로드 대상 ${pending.length}개 파일을 확인했습니다.`
  });

  for (const task of pending) {
    const totalBytes = totals.get(task.destination) || 0;
    await downloadHfFileWithProgress(task, options, {
      totalBytes,
      knownAggregateBytes: hasKnownAggregate ? knownTotalBytes : 0,
      completedBytes,
      onComplete: (bytesWritten) => {
        completedBytes += hasKnownAggregate ? totalBytes : bytesWritten;
      }
    });
  }

  emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 모델 파일 다운로드 완료", "모든 Paddle OCR 모델 파일을 로컬 캐시에 저장했습니다.", {
    progressMode: hasKnownAggregate ? "determinate" : "log-only",
    progressPercent: hasKnownAggregate ? 1 : undefined,
    progressBytes: hasKnownAggregate ? knownTotalBytes : undefined,
    progressTotalBytes: hasKnownAggregate ? knownTotalBytes : undefined,
    installLogLine: "Paddle OCR 모델 파일 다운로드가 완료되었습니다."
  });
}

function resolvePaddleOcrModelCacheDir(runtimeDir, modelName) {
  return path.join(runtimeDir, "paddlex-cache", "official_models", modelName);
}

function buildHfResolveUrl(endpoint, repo, file) {
  const filePath = String(file ?? "").replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
  return `${String(endpoint || "https://huggingface.co").replace(/\/+$/, "")}/${repo}/resolve/main/${filePath}`;
}

function getFileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function isUsableFile(filePath) {
  try {
    return Boolean(filePath) && statSync(filePath).isFile() && statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

async function probeContentLength(url, signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const timeoutMs = readPositiveInteger(process.env.MANGA_TRANSLATOR_DOWNLOAD_METADATA_TIMEOUT_MS) || DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS;
  const linked = createLinkedAbortController(signal);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    linked.controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { method: "HEAD", signal: linked.controller.signal });
    if (!response.ok) {
      return 0;
    }
    return readContentLength(response);
  } catch {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      return 0;
    }
    return 0;
  } finally {
    clearTimeout(timeout);
    linked.cleanup();
  }
}

async function downloadHfFileWithProgress(task, options = {}, progress = {}) {
  const maxAttempts = resolveDownloadRetryCount();
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await downloadHfFileWithProgressAttempt(task, options, progress, { attempt, maxAttempts });
    } catch (error) {
      if (options.abortSignal?.aborted || isAbortError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      emitDownloadRetryProgress(options, task, error, attempt + 1, maxAttempts);
      await delay(Math.min(30000, 1000 * 2 ** (attempt - 1)), undefined, { signal: options.abortSignal });
    }
  }
  throw lastError || createDetailedError(`${task.label} 다운로드에 실패했습니다.`, { url: task.url, file: task.file });
}

async function downloadHfFileWithProgressAttempt(task, options = {}, progress = {}, attemptState = {}) {
  const partPath = `${task.destination}.part`;
  await mkdir(path.dirname(task.destination), { recursive: true });
  await rm(partPath, { force: true });

  emitRuntimeProgress(options, task.progressPhase || "model_downloading", resolveDownloadProgressTitle(task, false), `${task.label}: ${task.file}`, {
    progressMode: progress.knownAggregateBytes || progress.totalBytes ? "determinate" : "log-only",
    progressPercent: progress.knownAggregateBytes ? progress.completedBytes / progress.knownAggregateBytes : progress.totalBytes ? 0 : undefined,
    progressBytes: progress.knownAggregateBytes ? progress.completedBytes : progress.totalBytes ? 0 : undefined,
    progressTotalBytes: progress.knownAggregateBytes || progress.totalBytes || undefined,
    installLogLine: attemptState.attempt > 1
      ? `${task.label} 다운로드 재시도 ${attemptState.attempt}/${attemptState.maxAttempts}: ${task.file}`
      : `${task.label} 다운로드 시작: ${task.file}`
  });

  const startedAt = Date.now();
  const totalBytes = progress.totalBytes || 0;
  const knownAggregateBytes = progress.knownAggregateBytes || 0;

  try {
    const receivedBytes = totalBytes > 0
      ? await downloadHfFileByRanges(task, options, progress, partPath, totalBytes, startedAt)
      : await downloadHfFileByStream(task, options, progress, partPath, startedAt);
    await rm(task.destination, { force: true });
    await rename(partPath, task.destination);
    progress.onComplete?.(receivedBytes);
    emitHfDownloadProgress(options, task, {
      receivedBytes,
      totalBytes,
      knownAggregateBytes,
      aggregateCompletedBytes: progress.completedBytes || 0,
      startedAt,
      completed: true
    });
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function downloadHfFileByRanges(task, options, progress, partPath, totalBytes, startedAt) {
  let file = null;
  try {
    file = await open(partPath, "w");
    await file.truncate(totalBytes);
    const knownAggregateBytes = progress.knownAggregateBytes || 0;
    let receivedBytes = 0;
    let lastEmitAt = 0;

    for (let start = 0; start < totalBytes; start += HF_DOWNLOAD_CHUNK_SIZE) {
      const end = Math.min(totalBytes - 1, start + HF_DOWNLOAD_CHUNK_SIZE - 1);
      let chunk = null;
      try {
        chunk = await fetchRangeBufferWithRetry(task, options, start, end);
      } catch (error) {
        if (error?.rangeUnsupported && start === 0) {
          await file.close();
          file = null;
          await rm(partPath, { force: true }).catch(() => {});
          return await downloadHfFileByStream(task, options, progress, partPath, startedAt);
        }
        throw error;
      }
      const expectedLength = end - start + 1;
      if (chunk.length !== expectedLength) {
        throw createDetailedError(`${task.label} 다운로드 조각 크기가 올바르지 않습니다.`, {
          url: task.url,
          file: task.file,
          rangeStart: start,
          rangeEnd: end,
          expectedLength,
          receivedLength: chunk.length
        });
      }
      await file.write(chunk, 0, chunk.length, start);
      receivedBytes += chunk.length;
      const now = Date.now();
      if (now - lastEmitAt > 500 || receivedBytes >= totalBytes) {
        lastEmitAt = now;
        emitHfDownloadProgress(options, task, {
          receivedBytes,
          totalBytes,
          knownAggregateBytes,
          aggregateCompletedBytes: progress.completedBytes || 0,
          startedAt
        });
      }
    }
    return receivedBytes;
  } finally {
    if (file) {
      await file.close().catch(() => {});
    }
  }
}

async function fetchRangeBufferWithRetry(task, options, start, end) {
  const maxAttempts = resolveDownloadRetryCount();
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchRangeBuffer(task, options, start, end);
    } catch (error) {
      if (options.abortSignal?.aborted || isAbortError(error) || error?.rangeUnsupported) {
        throw error;
      }
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      emitDownloadRetryProgress(options, task, error, attempt + 1, maxAttempts, `bytes=${start}-${end}`);
      await delay(Math.min(30000, 1000 * 2 ** (attempt - 1)), undefined, { signal: options.abortSignal });
    }
  }
  throw lastError || createDetailedError(`${task.label} 다운로드 조각에 실패했습니다.`, { url: task.url, file: task.file, rangeStart: start, rangeEnd: end });
}

async function fetchRangeBuffer(task, options, start, end) {
  const range = `bytes=${start}-${end}`;
  const stallTimeoutMs = resolveDownloadStallTimeoutMs();
  const linked = createLinkedAbortController(options.abortSignal);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    linked.controller.abort();
  }, stallTimeoutMs);
  try {
    const response = await fetch(task.url, {
      headers: { Range: range },
      signal: linked.controller.signal
    });
    if (response.status === 200) {
      throw createDetailedError(`${task.label} 서버가 범위 다운로드를 지원하지 않습니다.`, {
        rangeUnsupported: true,
        status: response.status,
        url: task.url,
        file: task.file
      });
    }
    if (response.status !== 206 || !response.ok) {
      throw createDetailedError(`${task.label} 다운로드 조각에 실패했습니다 (${response.status}).`, {
        status: response.status,
        statusText: response.statusText,
        url: task.url,
        file: task.file,
        range
      });
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (timedOut) {
      throw createDetailedError(`${task.label} 다운로드가 ${Math.round(stallTimeoutMs / 1000)}초 동안 응답하지 않았습니다.`, {
        url: task.url,
        file: task.file,
        range,
        stallTimeoutMs
      }, error);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    linked.cleanup();
  }
}

async function downloadHfFileByStream(task, options, progress, partPath, startedAt) {
  const stallTimeoutMs = resolveDownloadStallTimeoutMs();
  const linked = createLinkedAbortController(options.abortSignal);
  let timedOut = false;
  let timeout = null;
  const resetTimeout = () => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      timedOut = true;
      linked.controller.abort();
    }, stallTimeoutMs);
  };
  resetTimeout();

  const writer = createWriteStream(partPath, { flags: "wx" });
  try {
    const response = await fetch(task.url, { signal: linked.controller.signal });
    if (!response.ok || !response.body) {
      throw createDetailedError(`${task.label} 다운로드에 실패했습니다 (${response.status}).`, {
        status: response.status,
        statusText: response.statusText,
        url: task.url,
        file: task.file
      });
    }

    const totalBytes = progress.totalBytes || readContentLength(response);
    const knownAggregateBytes = progress.knownAggregateBytes || 0;
    const reader = response.body.getReader();
    let receivedBytes = 0;
    let lastEmitAt = 0;

    while (true) {
      if (options.abortSignal?.aborted) {
        throw createAbortError();
      }
      resetTimeout();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      resetTimeout();
      await writeStreamChunk(writer, Buffer.from(value));
      receivedBytes += value.byteLength;
      const now = Date.now();
      if (now - lastEmitAt > 500) {
        lastEmitAt = now;
        emitHfDownloadProgress(options, task, {
          receivedBytes,
          totalBytes,
          knownAggregateBytes,
          aggregateCompletedBytes: progress.completedBytes || 0,
          startedAt
        });
      }
    }
    await finishWriteStream(writer);
    return receivedBytes;
  } catch (error) {
    writer.destroy();
    if (timedOut) {
      throw createDetailedError(`${task.label} 다운로드가 ${Math.round(stallTimeoutMs / 1000)}초 동안 응답하지 않았습니다.`, {
        url: task.url,
        file: task.file,
        stallTimeoutMs
      }, error);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    linked.cleanup();
  }
}

function emitDownloadRetryProgress(options, task, error, nextAttempt, maxAttempts, range = "") {
  const suffix = range ? ` (${range})` : "";
  emitRuntimeProgress(options, task.progressPhase || "model_downloading", resolveDownloadProgressTitle(task, false), `${task.label}: ${task.file}`, {
    progressMode: "log-only",
    installLogLine: `${task.label} 다운로드 재시도 ${nextAttempt}/${maxAttempts}${suffix}: ${error instanceof Error ? error.message : String(error)}`
  });
}

function emitHfDownloadProgress(options, task, state) {
  const knownAggregateBytes = state.knownAggregateBytes || 0;
  const aggregateBytes = knownAggregateBytes
    ? Math.min(knownAggregateBytes, (state.aggregateCompletedBytes || 0) + state.receivedBytes)
    : undefined;
  const fileBytes = state.totalBytes ? Math.min(state.receivedBytes, state.totalBytes) : undefined;
  const progressPercent = knownAggregateBytes
    ? aggregateBytes / knownAggregateBytes
    : state.totalBytes
      ? fileBytes / state.totalBytes
      : undefined;
  const elapsedSeconds = Math.max(0.001, (Date.now() - state.startedAt) / 1000);
  const speed = Math.max(0, state.receivedBytes / elapsedSeconds);
  const fileProgress = state.totalBytes
    ? `${formatBytes(state.receivedBytes)} / ${formatBytes(state.totalBytes)}`
    : `${formatBytes(state.receivedBytes)} 받음`;
  emitRuntimeProgress(options, task.progressPhase || "model_downloading", resolveDownloadProgressTitle(task, Boolean(state.completed)), `${task.label}: ${task.file}`, {
    progressMode: knownAggregateBytes || state.totalBytes ? "determinate" : "log-only",
    progressPercent,
    progressBytes: aggregateBytes ?? fileBytes,
    progressTotalBytes: knownAggregateBytes || state.totalBytes || undefined,
    progressBytesPerSecond: speed,
    installLogLine: state.completed
      ? `${task.label} 다운로드 완료: ${task.file} (${fileProgress})`
      : `${task.label} 다운로드 중: ${task.file} (${fileProgress})`
  });
}

function resolveDownloadProgressTitle(task, completed) {
  if (completed) {
    return task.completeTitle || `${task.label} 다운로드 완료`;
  }
  return task.progressTitle || `${task.label} 다운로드 중`;
}

function resolveDownloadRetryCount() {
  return readPositiveInteger(process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT ?? process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRIES) || DEFAULT_DOWNLOAD_RETRY_COUNT;
}

function resolveDownloadStallTimeoutMs() {
  return readPositiveInteger(process.env.MANGA_TRANSLATOR_DOWNLOAD_STALL_TIMEOUT_MS) || DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS;
}

function createLinkedAbortController(parentSignal) {
  const controller = new AbortController();
  if (parentSignal?.aborted) {
    controller.abort();
    return { controller, cleanup: () => {} };
  }
  const onAbort = () => controller.abort();
  parentSignal?.addEventListener?.("abort", onAbort, { once: true });
  return {
    controller,
    cleanup: () => parentSignal?.removeEventListener?.("abort", onAbort)
  };
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function readContentLength(response) {
  const value = Number(response.headers?.get?.("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeStreamChunk(writer, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      writer.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      writer.off("error", onError);
      resolve();
    };
    writer.once("error", onError);
    if (writer.write(chunk)) {
      writer.off("error", onError);
      resolve();
      return;
    }
    writer.once("drain", onDrain);
  });
}

function finishWriteStream(writer) {
  return new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.end(resolve);
  });
}

function resolveCachedConfiguredDraftModelPath(options = {}) {
  const repo = resolveConfiguredDraftModelRepo(options);
  const file = resolveConfiguredDraftModelFile(options);
  if (!repo || !file) {
    return null;
  }
  const hubCacheDir = resolveHubCacheDir(options);
  if (!hubCacheDir) {
    return null;
  }
  const repoDir = repoCacheDir(repo, hubCacheDir);
  if (!existsSync(repoDir)) {
    return null;
  }
  for (const snapshotDir of listSnapshotDirs(repoDir)) {
    const draftPath = path.join(snapshotDir, file);
    if (existsSync(draftPath)) {
      return draftPath;
    }
  }
  return findNamedFile(repoDir, file);
}

function resolveCachedModelAssets(options = {}) {
  const hubCacheDir = resolveHubCacheDir(options);
  const configuredMmprojPath = resolveCachedConfiguredMmprojPath(options);
  const configuredMmprojUrl = configuredMmprojPath ? null : resolveConfiguredMmprojUrl(options);
  const draftModelPath = resolveCachedConfiguredDraftModelPath(options);
  const draftModelUrl = draftModelPath ? null : resolveConfiguredDraftModelUrl(options);
  const requiresDraftDownload = Boolean(options.useDraft && !draftModelPath && draftModelUrl);
  if (!hubCacheDir) {
    return {
      hubCacheDir: null,
      repoDir: null,
      snapshotDir: null,
      modelPath: null,
      mmprojPath: configuredMmprojPath,
      mmprojUrl: configuredMmprojUrl,
      draftModelPath,
      draftModelUrl,
      launchMode: "huggingface",
      requiresDownload: true
    };
  }

  const repoDir = repoCacheDir(resolveConfiguredModelRepo(options), hubCacheDir);
  if (!existsSync(repoDir)) {
    return {
      hubCacheDir,
      repoDir,
      snapshotDir: null,
      modelPath: null,
      mmprojPath: configuredMmprojPath,
      mmprojUrl: configuredMmprojUrl,
      draftModelPath,
      draftModelUrl,
      launchMode: "huggingface",
      requiresDownload: true
    };
  }

  const configuredModelFile = resolveConfiguredModelFile(options);
  for (const snapshotDir of listSnapshotDirs(repoDir)) {
    const modelPath = path.join(snapshotDir, configuredModelFile);
    if (!existsSync(modelPath)) {
      continue;
    }

    const mmprojPath = configuredMmprojPath || findPreferredMmprojFile(snapshotDir);
    if (mmprojPath) {
      return {
        hubCacheDir,
        repoDir,
        snapshotDir,
        modelPath,
        mmprojPath,
        mmprojUrl: null,
        draftModelPath,
        draftModelUrl,
        launchMode: "cached-hf",
        requiresDownload: requiresDraftDownload
      };
    }

    if (configuredMmprojUrl) {
      return {
        hubCacheDir,
        repoDir,
        snapshotDir,
        modelPath,
        mmprojPath: null,
        mmprojUrl: configuredMmprojUrl,
        draftModelPath,
        draftModelUrl,
        launchMode: "cached-hf",
        requiresDownload: true
      };
    }
  }

  const modelPath = findNamedFile(repoDir, configuredModelFile);
  if (!modelPath) {
    return {
      hubCacheDir,
      repoDir,
      snapshotDir: null,
      modelPath: null,
      mmprojPath: configuredMmprojPath,
      mmprojUrl: configuredMmprojUrl,
      draftModelPath,
      draftModelUrl,
      launchMode: "huggingface",
      requiresDownload: true
    };
  }

  const snapshotDir = path.dirname(modelPath);
  const mmprojPath = configuredMmprojPath || findPreferredMmprojFile(snapshotDir);
  return {
    hubCacheDir,
    repoDir,
    snapshotDir,
    modelPath,
    mmprojPath,
    mmprojUrl: mmprojPath ? null : configuredMmprojUrl,
    draftModelPath,
    draftModelUrl,
    launchMode: "cached-hf",
    requiresDownload: (!mmprojPath && Boolean(configuredMmprojUrl)) || requiresDraftDownload
  };
}

function inspectModelLaunch(options = {}) {
  if (isOpenAICodexProvider(options)) {
    return {
      launchMode: "openai-codex",
      model: resolveConfiguredCodexModel(options),
      reasoningEffort: resolveConfiguredCodexReasoningEffort(options),
      requiresDownload: false
    };
  }

  if (resolveConfiguredModelSource(options) === "local") {
    const modelPath = resolveConfiguredLocalModelPath(options);
    const explicitMmprojPath = resolveConfiguredLocalMmprojPath(options);
    const detectedMmprojPath = modelPath ? findPreferredMmprojFile(path.dirname(modelPath)) : null;
    const mmprojPath = explicitMmprojPath || detectedMmprojPath;
    const draftModelPath = options.useDraft ? resolveCachedConfiguredDraftModelPath(options) : null;
    const draftModelUrl = options.useDraft ? resolveConfiguredDraftModelUrl(options) : null;

    return {
      launchMode: "local",
      modelPath,
      mmprojPath,
      draftModelPath,
      draftModelUrl,
      requiresDownload: Boolean(options.useDraft && !draftModelPath && draftModelUrl)
    };
  }

  const cachedAssets = resolveCachedModelAssets(options);
  return {
    ...cachedAssets,
    requiresDownload: Boolean(cachedAssets.requiresDownload ?? cachedAssets.launchMode !== "cached-hf")
  };
}

function isModelCached(options = {}) {
  const launchTarget = inspectModelLaunch(options);
  if (launchTarget.launchMode === "openai-codex") {
    return true;
  }
  if (launchTarget.launchMode === "local") {
    return Boolean(
      launchTarget.modelPath &&
        existsSync(launchTarget.modelPath) &&
        (!options.useDraft || launchTarget.draftModelPath)
    );
  }
  return launchTarget.launchMode === "cached-hf" && !launchTarget.requiresDownload;
}

async function convertImageToPngBufferWithFfmpeg(filePath, options = {}) {
  const ffmpegPath = resolveFfmpegPath(options);
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1"
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildUtilityChildEnv(options, [path.dirname(ffmpegPath)])
      }
    );

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      reject(
        createDetailedError(
          "ffmpeg failed to start for image conversion.",
          {
            filePath,
            targetMime: "image/png",
            command: ffmpegPath
          },
          error
        )
      );
    });

    child.on("close", (code) => {
      const output = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code !== 0) {
        reject(
          createDetailedError("ffmpeg image conversion failed.", {
            filePath,
            targetMime: "image/png",
            command: ffmpegPath,
            exitCode: code,
            stderr
          })
        );
        return;
      }

      if (!output.length) {
        reject(
          createDetailedError("ffmpeg image conversion produced no output.", {
            filePath,
            targetMime: "image/png",
            command: ffmpegPath,
            exitCode: code,
            stderr
          })
        );
        return;
      }

      resolve(output);
    });
  });
}

async function fileToModelAsset(filePath, options = {}) {
  const sourceMime = mimeFromPath(filePath);

  if (sourceMime === "image/webp") {
    const convertedBuffer = await convertImageToPngBufferWithFfmpeg(filePath, options);
    return {
      mime: "image/png",
      convertedFromMime: sourceMime,
      dataUrl: `data:image/png;base64,${convertedBuffer.toString("base64")}`
    };
  }

  const buffer = await readFile(filePath);
  return {
    mime: sourceMime,
    convertedFromMime: null,
    dataUrl: `data:${sourceMime};base64,${buffer.toString("base64")}`
  };
}

async function buildEnhancedVariant(options) {
  const nativeImage = resolveElectronNativeImage();
  let electronError = null;

  if (nativeImage) {
    try {
      return await buildEnhancedVariantWithElectron(options, nativeImage);
    } catch (error) {
      electronError = error;
    }
  }

  try {
    return await buildEnhancedVariantWithPowerShell(options);
  } catch (error) {
    if (!electronError) {
      throw error;
    }

    throw createDetailedError(
      "Enhanced variant generation failed in both Electron and PowerShell pipelines.",
      {
        imagePath: options.imagePath,
        outputDir: options.outputDir,
        electronError
      },
      error
    );
  }
}

function resolveImageSize(options = {}) {
  const configuredWidth = readPositiveInteger(options.imageWidth);
  const configuredHeight = readPositiveInteger(options.imageHeight);
  if (configuredWidth && configuredHeight) {
    return { width: configuredWidth, height: configuredHeight };
  }

  const nativeImage = resolveElectronNativeImage();
  if (!nativeImage || !options.imagePath) {
    return { width: 0, height: 0 };
  }

  const image = nativeImage.createFromPath(options.imagePath);
  const size = image?.getSize?.() || { width: 0, height: 0 };
  return {
    width: readPositiveInteger(size.width) || 0,
    height: readPositiveInteger(size.height) || 0
  };
}

async function buildOpenAIVisionVariant(options) {
  const sourceSize = resolveImageSize(options);
  const targetSize = calculateOpenAIOriginalDetailSize(sourceSize.width, sourceSize.height);
  const base = {
    role: "openai-vision",
    originalWidth: sourceSize.width,
    originalHeight: sourceSize.height,
    width: targetSize.width || sourceSize.width,
    height: targetSize.height || sourceSize.height
  };

  if (!sourceSize.width || !sourceSize.height || !targetSize.width || !targetSize.height) {
    return { ...base, role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height };
  }

  if (targetSize.width === sourceSize.width && targetSize.height === sourceSize.height) {
    return { ...base, path: options.imagePath };
  }

  const nativeImage = resolveElectronNativeImage();
  if (!nativeImage) {
    return { ...base, role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height };
  }

  const image = nativeImage.createFromPath(options.imagePath);
  if (!image || image.isEmpty()) {
    return { ...base, role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height };
  }

  const outputPath = path.join(options.outputDir, "input-openai-vision.png");
  const resized = image.resize({
    width: targetSize.width,
    height: targetSize.height,
    quality: "best"
  });
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(outputPath, resized.toPNG());
  return { ...base, path: outputPath };
}

async function buildEnhancedVariantWithElectron(options, nativeImage) {
  const outputPath = path.join(options.outputDir, "input-enhanced.png");
  const image = nativeImage.createFromPath(options.imagePath);
  if (!image || image.isEmpty()) {
    throw createDetailedError("Electron nativeImage could not decode the source image.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase()
    });
  }

  const sourceSize = image.getSize();
  if (!sourceSize.width || !sourceSize.height) {
    throw createDetailedError("Electron nativeImage returned an empty size for the source image.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase(),
      sourceSize
    });
  }

  const scaled = getScaledSize(sourceSize.width, sourceSize.height, options.enhancedMaxLongSide);
  const resized =
    scaled.width === sourceSize.width && scaled.height === sourceSize.height
      ? image
      : image.resize({
          width: scaled.width,
          height: scaled.height,
          quality: "best"
        });

  if (!resized || resized.isEmpty()) {
    throw createDetailedError("Electron nativeImage resize returned an empty image.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase(),
      sourceSize,
      scaled
    });
  }

  const bitmap = resized.toBitmap();
  if (!bitmap || bitmap.length === 0) {
    throw createDetailedError("Electron nativeImage returned an empty bitmap buffer.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase(),
      sourceSize,
      scaled
    });
  }

  const enhancedBitmap = enhanceBitmapBuffer(bitmap, options.enhancedContrast, true);
  const enhancedImage = nativeImage.createFromBitmap(enhancedBitmap, {
    width: scaled.width,
    height: scaled.height
  });
  if (!enhancedImage || enhancedImage.isEmpty()) {
    throw createDetailedError("Electron nativeImage could not create the enhanced bitmap.", {
      imagePath: options.imagePath,
      outputPath,
      format: path.extname(options.imagePath).toLowerCase(),
      sourceSize,
      scaled
    });
  }

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(outputPath, enhancedImage.toPNG());
  return outputPath;
}

async function buildEnhancedVariantWithPowerShell(options) {
  const outputPath = path.join(options.outputDir, "input-enhanced.png");
  const scriptPath = path.join(__dirname, "build-page-variant.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Path",
    options.imagePath,
    "-OutputPath",
    outputPath,
    "-MaxLongSide",
    String(options.enhancedMaxLongSide),
    "-Contrast",
    String(options.enhancedContrast),
    "-Grayscale"
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("powershell", args, {
      cwd: resolveWorkingDir(options),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: buildUtilityChildEnv(options)
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 4000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 4000);
    });
    child.on("error", (error) => {
      reject(
        createDetailedError(
          "Failed to launch build-page-variant.ps1.",
          {
            scriptPath,
            imagePath: options.imagePath,
            outputPath,
            stdout: truncateText(stdout, 4000),
            stderr: truncateText(stderr, 4000),
            parameters: {
              maxLongSide: options.enhancedMaxLongSide,
              contrast: options.enhancedContrast,
              grayscale: true
            }
          },
          error
        )
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        createDetailedError(`build-page-variant.ps1 failed (${code ?? "null"}).`, {
          scriptPath,
          imagePath: options.imagePath,
          outputPath,
          stdout: truncateText(stdout.trim(), 4000),
          stderr: truncateText(stderr.trim(), 4000),
          parameters: {
            maxLongSide: options.enhancedMaxLongSide,
            contrast: options.enhancedContrast,
            grayscale: true
          }
        })
      );
    });
  });

  return outputPath;
}

async function prepareImageVariants(options) {
  const sourceSize = resolveImageSize(options);
  const variants = isOpenAICodexProvider(options)
    ? [await buildOpenAIVisionVariant({ ...options, imageWidth: sourceSize.width, imageHeight: sourceSize.height })]
    : [{ role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height }];
  let diagnostics = [];
  if (options.includeEnhancedVariant) {
    try {
      variants.push({ role: "enhanced", path: await buildEnhancedVariant(options), originalWidth: sourceSize.width, originalHeight: sourceSize.height });
    } catch (error) {
      diagnostics = [buildEnhancedVariantFailureDetail(error, options)];
      process.stderr.write(
        `[runtime:${options.label}:warn] enhanced variant unavailable; continuing with original image only (${diagnostics[0].message})\n`
      );
    }
  }

  return {
    imageVariants: await Promise.all(
      variants.map(async (variant) => ({
        ...variant,
        ...(await fileToModelAsset(variant.path, options))
      }))
    ),
    diagnostics
  };
}

function buildMessages(options, imageVariants) {
  const promptText = options.promptOverrideText || getOverlayPrompt(options, imageVariants);
  const imageParts = imageVariants.flatMap((variant, index) => ([
    {
      type: "image_url",
      image_url: {
        url: variant.dataUrl
      }
    },
    {
      type: "text",
      text: describeImageVariant(variant, index, options)
    }
  ]));

  return [
    {
      role: "system",
      content: [{ type: "text", text: buildSystemPrompt(options) }]
    },
    {
      role: "user",
      content: [...imageParts, { type: "text", text: promptText }]
    }
  ];
}

function buildResponsesInput(options, imageVariants, promptText = options.promptOverrideText || getOverlayPrompt(options, imageVariants)) {
  const content = imageVariants.flatMap((variant, index) => ([
    {
      type: "input_image",
      image_url: variant.dataUrl,
      detail: "original"
    },
    {
      type: "input_text",
      text: describeImageVariant(variant, index, options)
    }
  ]));

  return [
    {
      role: "user",
      content: [...content, { type: "input_text", text: promptText }]
    }
  ];
}

function describeImageVariant(variant, index, options = {}) {
  const originalWidth = readPositiveInteger(options.imageWidth) || readPositiveInteger(variant.originalWidth);
  const originalHeight = readPositiveInteger(options.imageHeight) || readPositiveInteger(variant.originalHeight);
  const width = readPositiveInteger(variant.width);
  const height = readPositiveInteger(variant.height);
  const sizeText = width && height ? ` It is ${width}x${height} px.` : "";
  const originalSizeText = originalWidth && originalHeight ? ` Original page size is ${originalWidth}x${originalHeight} px.` : "";

  if (variant.role === "openai-vision") {
    return `Image ${index + 1}: the full manga page prepared for OpenAI detail: original vision. Use it as the geometry authority.${sizeText}${originalSizeText}`;
  }

  if (variant.role === "enhanced") {
    return `Image ${index + 1}: the same full manga page rendered as grayscale/high-contrast assist view. Use it only for OCR help, never as the coordinate authority.${sizeText}${originalSizeText}`;
  }

  if (variant.role === "crop-retry") {
    const idText = Array.isArray(variant.itemIds) && variant.itemIds.length > 0
      ? ` item ids ${variant.itemIds.join(", ")}`
      : Number.isFinite(Number(variant.itemId))
        ? ` item id ${variant.itemId}`
        : " one low-confidence item";
    const box = variant.cropBox
      ? ` Crop on original page: x=${variant.cropBox.x}, y=${variant.cropBox.y}, w=${variant.cropBox.w}, h=${variant.cropBox.h}.`
      : "";
    return `Image ${index + 1}: expanded crop for${idText}. Use it only to re-read that same id; do not create new ids or change geometry.${sizeText}${originalSizeText}${box}`;
  }

  return `Image ${index + 1}: the original full manga page. Use it as the geometry authority.${sizeText}${originalSizeText}`;
}

function buildCropRetryPrompt(targets = []) {
  const targetLines = targets.map((target, index) => {
    const cropImageIndex = Number.isFinite(Number(target.cropImageIndex)) ? Number(target.cropImageIndex) : index + 2;
    const confidence = Number.isFinite(Number(target.confidence)) ? Number(target.confidence).toFixed(2) : "unknown";
    const bbox = target.bbox
      ? `bbox x=${target.bbox.x} y=${target.bbox.y} w=${target.bbox.w} h=${target.bbox.h}`
      : "bbox unchanged";
    const cropSize = target.cropBox
      ? `cropSize:${Math.round(Number(target.cropBox.w) || 0)}x${Math.round(Number(target.cropBox.h) || 0)}`
      : "cropSize:unknown";
    return [
      `target ${target.id}: cropImage:${cropImageIndex}`,
      `reason:${target.reason || "low-confidence"}`,
      target.cropGroupId ? `cropGroup:${target.cropGroupId}` : "",
      cropSize,
      `type:${target.type || "nonsolid"} textRole:${target.textRole || ""} direction:${target.direction || "horizontal"} angle:${Number.isFinite(Number(target.angle)) ? target.angle : 0} fontSize:${Number.isFinite(Number(target.fontSize)) ? target.fontSize : ""} confidence:${confidence}`,
      bbox
    ].filter(Boolean).join(" ");
  });

  return [
    "# Task",
    "You are directly OCR-reading and translating only the listed manga crop images.",
    "Image 1 is the full page for context only. Each following image is an expanded crop for exactly one target id.",
    "Do not detect new ids or output extra ids.",
    "For each target, ignore any previous model OCR/translation. The crop image itself is the authority.",
    "Read the real Japanese text inside that crop for the same target id. If the crop contains the target text, return the tight crop-coordinate bbox for the visible Japanese glyphs.",
    "Several target ids may point to the same crop image. In that case, use the larger crop as context and return separate records for the separate visible Japanese lettering groups represented by those target ids.",
    "If a large sound effect was split into nearby target ids, keep those ids separate when the visible lettering groups are separate. Do not create one giant combined translation over the whole crop.",
    "For sound-check targets, decide whether the crop is standalone printed sound/reaction lettering, ordinary language, or non-text. Sound/reaction lettering should become compact Korean effect lettering, not a scene description and not a mechanical kana transliteration.",
    "If the crop text is inside a speech bubble, caption, note, sign, or label, treat it as ordinary language unless the visible lettering is unmistakably standalone sound/reaction lettering.",
    "",
    "# Output",
    "Return plain text records only. Do not output JSON, markdown, bullets, commentary, or code fences.",
    "Output exactly one record for each target id, using exactly these keys: id, type, textRole, x1, y1, x2, y2, direction, angle, fontSize, confidence, jp, ko.",
    "x1, y1, x2, y2 are integer crop image pixel coordinates around the visible Japanese glyph ink for that target, not full-page coordinates.",
    "Crop coordinates start at 0,0 in the top-left corner of the crop image. x1 and x2 must be within the crop image width; y1 and y2 must be within the crop image height.",
    "Never copy the target bbox or crop origin numbers into x1/y1/x2/y2; those are page coordinates, not crop coordinates.",
    "textRole is one of sound, ordinary, or nontext.",
    "confidence is 0.00 to 1.00 for the corrected OCR+translation.",
    "If textRole is sound, use confidence 1.00 only when the complete sound effect is unquestionably real Japanese text and every glyph, including final/trailing kana, is read correctly. If there is any doubt, use confidence below 1.00.",
    "If the crop is decoration, panel trim, texture, non-Japanese art, or otherwise not real Japanese text, output type: reject, textRole: nontext, confidence: 1, jp: [non-text], ko: [non-text].",
    "If the crop still has readable Japanese, never output only [?]; give the best OCR and concise natural Korean.",
    "Use type nonsolid for every accepted text target.",
    "If textRole is ordinary, keep dialogue/caption/label Korean natural, horizontally readable, and do not apply sound-effect rules.",
    "For ordinary textRole, translate the Japanese lexical meaning. Never replace an ordinary word, noun, label, or dialogue fragment with a Korean sound effect.",
    "Short kana, handwritten words, or tall vertical bbox shapes are not enough to make textRole sound.",
    "For sound-effect or reaction lettering, ko must be bare Korean effect lettering only: no parentheses, brackets, quotes, stage directions, action descriptions, or explanatory notes.",
    "If textRole is sound, choose compact Korean effect lettering that fits the scene and visible rhythm. Do not mechanically transliterate Japanese kana when that would sound awkward in Korean.",
    "If textRole is sound, avoid Korean grammar endings, particles, connective endings, explanatory spacing, adverbs, and action descriptions.",
    "",
    "# Targets",
    ...targetLines
  ].join("\n");
}

async function prepareCropRetryImageVariants(options, targets = []) {
  const sourceSize = resolveImageSize(options);
  const fullPageVariant = isOpenAICodexProvider(options)
    ? await buildOpenAIVisionVariant({ ...options, imageWidth: sourceSize.width, imageHeight: sourceSize.height })
    : { role: "original", path: options.imagePath, width: sourceSize.width, height: sourceSize.height };
  const cropVariants = await buildCropRetryVariants(options, targets, sourceSize);
  const variants = [fullPageVariant, ...cropVariants];

  return {
    imageVariants: await Promise.all(
      variants.map(async (variant) => ({
        ...variant,
        ...(await fileToModelAsset(variant.path))
      }))
    )
  };
}

async function buildCropRetryVariants(options, targets = [], sourceSize = {}) {
  const nativeImage = resolveElectronNativeImage();
  if (!nativeImage) {
    throw createDetailedError("Electron nativeImage is required for crop retry images.", {
      imagePath: options.imagePath,
      targetCount: targets.length
    });
  }

  const image = await loadNativeImageForCropping(nativeImage, options.imagePath);
  if (!image || image.isEmpty()) {
    throw createDetailedError("Electron nativeImage could not decode source image for crop retry.", {
      imagePath: options.imagePath,
      targetCount: targets.length
    });
  }

  const imageSize = image.getSize();
  const pageWidth = readPositiveInteger(sourceSize.width) || readPositiveInteger(imageSize.width);
  const pageHeight = readPositiveInteger(sourceSize.height) || readPositiveInteger(imageSize.height);
  const outputDir = path.join(options.outputDir, "crop-retry-inputs");
  await mkdir(outputDir, { recursive: true });

  const variants = [];
  for (const group of groupCropRetryTargets(targets)) {
    const cropBox = normalizeCropBox(group.cropBox, pageWidth, pageHeight);
    if (!cropBox) {
      continue;
    }
    const cropped = image.crop(cropBox);
    if (!cropped || cropped.isEmpty()) {
      continue;
    }
    const imageIndex = variants.length + 2;
    for (const target of group.targets) {
      target.cropImageIndex = imageIndex;
    }

    const outputPath = path.join(outputDir, `${group.id}.png`);
    await writeFile(outputPath, cropped.toPNG());
    variants.push({
      role: "crop-retry",
      itemId: group.id,
      itemIds: group.targets.map((target) => target.id),
      cropBox,
      path: outputPath,
      width: cropBox.width,
      height: cropBox.height,
      originalWidth: pageWidth,
      originalHeight: pageHeight
    });
  }
  return variants;
}

function groupCropRetryTargets(targets = []) {
  const groups = new Map();
  for (const target of targets) {
    const key = target.cropGroupId || `item-${target.id}`;
    const previous = groups.get(key);
    if (previous) {
      previous.targets.push(target);
      continue;
    }
    groups.set(key, {
      id: key.replace(/[^A-Za-z0-9_.-]+/g, "-"),
      cropBox: target.cropBox,
      targets: [target]
    });
  }
  return [...groups.values()];
}

async function loadNativeImageForCropping(nativeImage, filePath) {
  if (mimeFromPath(filePath) === "image/webp") {
    const pngBuffer = await convertImageToPngBufferWithFfmpeg(filePath);
    return nativeImage.createFromBuffer(pngBuffer);
  }

  return nativeImage.createFromPath(filePath);
}

function normalizeCropBox(box, pageWidth, pageHeight) {
  if (!box || !pageWidth || !pageHeight) {
    return null;
  }
  const x = Math.max(0, Math.min(pageWidth - 1, Math.round(Number(box.x))));
  const y = Math.max(0, Math.min(pageHeight - 1, Math.round(Number(box.y))));
  const right = Math.max(x + 1, Math.min(pageWidth, Math.round(Number(box.x) + Number(box.w))));
  const bottom = Math.max(y + 1, Math.min(pageHeight, Math.round(Number(box.y) + Number(box.h))));
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function resolveRequestModelName(options = {}) {
  if (isOpenAICodexProvider(options)) {
    return resolveConfiguredCodexModel(options);
  }
  const launchTarget = inspectModelLaunch(options);
  if (launchTarget.launchMode === "local" && launchTarget.modelPath) {
    return path.basename(launchTarget.modelPath);
  }
  return resolveConfiguredModelRepo(options);
}

function buildChatRequestHeaders(options = {}) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (!isOpenAICodexProvider(options)) {
    headers.Authorization = `Bearer ${DEFAULT_API_KEY}`;
  }
  return headers;
}

function buildChatRequestBody(options, messages, maxTokens = options.maxTokens) {
  if (isOpenAICodexProvider(options)) {
    return {
      model: resolveRequestModelName(options),
      max_tokens: maxTokens,
      reasoning_effort: resolveConfiguredCodexReasoningEffort(options),
      messages
    };
  }

  return {
    model: resolveRequestModelName(options),
    temperature: options.temperature,
    top_p: options.topP,
    top_k: options.topK,
    presence_penalty: 0,
    frequency_penalty: 0,
    max_tokens: maxTokens,
    reasoning_budget: 0,
    enable_thinking: false,
    messages
  };
}

function buildResponsesRequestBody(options, imageVariants, promptText, systemPrompt) {
  return {
    model: resolveRequestModelName(options),
    instructions: systemPrompt || buildSystemPrompt(options),
    input: buildResponsesInput(options, imageVariants, promptText),
    max_output_tokens: options.maxTokens,
    reasoning: {
      effort: resolveConfiguredCodexReasoningEffort(options)
    },
    stream: true,
    store: false
  };
}

function resolveOcrBboxProvider(options = {}) {
  const explicit = String(options.ocrBboxProvider ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_PROVIDER", options) ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_DISABLE_OCR_BBOX", options))) {
    return "none";
  }
  if (isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_VL", options))) {
    return "paddleocr-vl";
  }
  if (String(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_CMD", options) ?? "").trim()) {
    return "external-command";
  }
  if (String(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH", options) ?? "").trim()) {
    return "json-file";
  }
  return "paddleocr-vl";
}

function isTruthy(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

async function collectOcrBboxHints(options = {}) {
  const diagnostics = [];
  if (options.skipOcrBboxHints) {
    return buildOcrBboxResult([], [{ provider: "disabled", reason: "skipOcrBboxHints" }], { noTextDetected: false });
  }

  const inlineHints = normalizeOcrBboxHintPayload(options.ocrBboxHints, options);
  if (Object.prototype.hasOwnProperty.call(options, "ocrBboxHints")) {
    return buildOcrBboxResult(inlineHints, [{
        provider: "inline",
        hintCount: inlineHints.length
      }]);
  }

  const hintsPath = String(options.ocrBboxHintsPath ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH", options) ?? "").trim();
  if (hintsPath) {
    try {
      const rawText = await readFile(hintsPath, "utf8");
      const hints = normalizeOcrBboxHintPayload(JSON.parse(rawText), options);
      return buildOcrBboxResult(hints, [{ provider: "json-file", path: hintsPath }]);
    } catch (error) {
      diagnostics.push(buildOcrBboxDiagnostic("json-file", error, { path: hintsPath }));
    }
  }

  const provider = resolveOcrBboxProvider(options);
  if (provider === "none" || provider === "json-file") {
    return buildOcrBboxResult([], diagnostics, { noTextDetected: false });
  }

  try {
    emitRuntimeProgress(options, "ocr_preparing", "Paddle OCR 준비 중", `장치: ${resolveOcrDeviceLabel(options)}`);
    const commandResult = await runOcrBboxCommand(options, provider);
    const hints = normalizeOcrBboxHintPayload(commandResult.payload, options);
    const result = buildOcrBboxResult(hints, [{
        provider,
        command: commandResult.command,
        outputPath: commandResult.outputPath,
        runtimeDir: commandResult.runtimeDir || null,
        runtimeVariant: commandResult.runtimeVariant || null,
        packageDir: commandResult.packageDir || null,
        pythonPath: commandResult.pythonPath || null,
        runtimePrepared: commandResult.runtimePrepared || false,
        hintCount: hints.length,
        stdoutPreview: truncateText(commandResult.stdout.trim(), 1200),
        stderrPreview: truncateText(commandResult.stderr.trim(), 1200),
        runtimeDiagnostics: commandResult.runtimeDiagnostics || []
      }]);
    emitRuntimeProgress(
      options,
      "ocr_running",
      result.noTextDetected ? "Paddle OCR 텍스트 없음" : `Paddle OCR 후보 ${hints.length}개 감지`,
      result.noTextDetected ? `장치: ${resolveOcrDeviceLabel(options)}, 텍스트 근거 없음` : `장치: ${resolveOcrDeviceLabel(options)}`
    );
    return result;
  } catch (error) {
    const diagnostic = buildOcrBboxDiagnostic(provider, error);
    diagnostics.push(diagnostic);
    if (provider === "paddleocr-vl" && isOcrGpuRequested(options)) {
      const failureMessage = buildPaddleOcrGpuFailureMessage(error, options);
      emitRuntimeProgress(options, "ocr_running", "Paddle OCR GPU 실행 실패", failureMessage);
      throw createOcrRuntimeError(
        failureMessage,
        { diagnostics },
        error
      );
    }
    return buildOcrBboxResult([], diagnostics, { noTextDetected: false });
  }
}

function buildOcrBboxResult(hints = [], diagnostics = [], options = {}) {
  const normalizedHints = Array.isArray(hints) ? hints : [];
  const textEvidenceCount = countOcrTextEvidence(normalizedHints);
  const noTextDetected =
    typeof options.noTextDetected === "boolean"
      ? options.noTextDetected
      : normalizedHints.length === 0;
  return {
    hints: normalizedHints,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    noTextDetected,
    textEvidenceCount
  };
}

function countOcrTextEvidence(hints = []) {
  return hints.reduce((count, hint) => count + (hasJapaneseTextEvidence(readOcrCandidateText(hint)) ? 1 : 0), 0);
}

function hasJapaneseTextEvidence(value) {
  const text = String(value ?? "");
  for (const char of text) {
    const code = char.codePointAt(0);
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x31f0 && code <= 0x31ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      code === 0x3005 ||
      code === 0x30fc
    ) {
      return true;
    }
  }
  return false;
}

function buildOcrBboxDiagnostic(provider, error, extra = {}) {
  return {
    provider,
    reason: "ocr-bbox-unavailable",
    message: summarizeOcrErrorMessage(error),
    ...extra
  };
}

async function runOcrBboxCommand(options = {}, provider = "external-command") {
  await mkdir(options.outputDir, { recursive: true });
  const outputPath = path.join(options.outputDir, "ocr-bbox-hints.json");
  const runtime = provider === "paddleocr-vl" ? await ensurePaddleOcrRuntime(options) : null;
  const command = buildOcrBboxCommand(options, provider, outputPath, runtime);
  emitRuntimeProgress(options, "ocr_running", "Paddle OCR 모델 다운로드/위치 분석 중", `장치: ${resolveOcrDeviceLabel(options)}`);
  const handleOcrOutput = createOcrCommandProgressHandler(options, {
    progressText: "Paddle OCR 모델 다운로드/위치 분석 중"
  });
  const { stdout, stderr } = await runShellCommand(command, {
    timeoutMs: resolveOcrBboxTimeoutMs(1),
    env: buildOcrRuntimeEnv(options, runtime),
    signal: options.abortSignal,
    onOutput: handleOcrOutput
  });

  let rawText = "";
  if (existsSync(outputPath)) {
    rawText = await readFile(outputPath, "utf8");
  } else {
    rawText = extractJsonText(stdout);
  }

  if (!rawText.trim()) {
    throw createDetailedError("OCR bbox command did not produce JSON.", {
      command,
      outputPath,
      stdoutPreview: truncateText(stdout, 2000),
      stderrPreview: truncateText(stderr, 2000)
    });
  }

  return {
    command,
    outputPath,
    runtimeDir: runtime?.runtimeDir || null,
    runtimeVariant: runtime?.runtimeVariant || null,
    packageDir: runtime?.packageDir || null,
    pythonPath: runtime?.pythonPath || null,
    runtimePrepared: Boolean(runtime?.prepared),
    runtimeDiagnostics: runtime?.diagnostics || [],
    stdout,
    stderr,
    payload: JSON.parse(rawText)
  };
}

async function collectOcrBboxHintsBatch(pageOptionsList = []) {
  const normalizedOptions = pageOptionsList.filter(Boolean);
  if (normalizedOptions.length === 0) {
    return [];
  }

  const firstOptions = normalizedOptions[0] || {};
  const batchOptions = withoutPageProgressOptions(firstOptions);
  const provider = resolveOcrBboxProvider(firstOptions);
  if (provider !== "paddleocr-vl") {
    const results = [];
    for (const options of normalizedOptions) {
      results.push(await collectOcrBboxHints(options));
    }
    return results;
  }

  const runtime = await ensurePaddleOcrRuntime(batchOptions);
  const batchPath = path.join(firstOptions.outputDir || process.cwd(), `ocr-batch-${Date.now()}-${process.pid}.json`);
  const progressPath = path.join(firstOptions.outputDir || process.cwd(), `ocr-batch-progress-${Date.now()}-${process.pid}.jsonl`);
  const items = normalizedOptions.map((options, index) => {
    const outputDir = options.outputDir || path.join(firstOptions.outputDir || process.cwd(), `page-${index + 1}`);
    return {
      image: options.imagePath,
      output: path.join(outputDir, "ocr-bbox-hints.json")
    };
  });
  await mkdir(path.dirname(batchPath), { recursive: true });
  for (const item of items) {
    await mkdir(path.dirname(item.output), { recursive: true });
  }
  await writeFile(batchPath, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");
  await writeFile(progressPath, "", "utf8");

  const command = buildOcrBboxBatchCommand(batchOptions, batchPath, runtime, progressPath);
  emitRuntimeProgress(batchOptions, "ocr_running", "Paddle OCR 배치 위치 분석 중", `${items.length}페이지, 장치: ${resolveOcrDeviceLabel(batchOptions)}`, {
    pageIndex: null,
    pageTotal: null,
    progressCurrent: readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0,
    progressTotal: readPositiveInteger(firstOptions.ocrBatchTotal) || items.length
  });
  const seenProgressEvents = new Set();
  const handleCommandOutput = createOcrCommandProgressHandler(batchOptions, {
    progressText: "Paddle OCR 배치 위치 분석 중",
    progressCurrent: readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0,
    progressTotal: readPositiveInteger(firstOptions.ocrBatchTotal) || items.length
  });
  const handleProgressLine = (line) => {
      const progress = parseOcrBatchProgressLine(line);
      if (!progress) {
        handleCommandOutput(line);
        return;
      }
      const phase = progress.phase || "done";
      const eventKey = `${phase}:${progress.index}:${progress.total}`;
      if (seenProgressEvents.has(eventKey)) {
        return;
      }
      seenProgressEvents.add(eventKey);
      const pageOptions = normalizedOptions[progress.index - 1] || firstOptions;
      const completedBefore = readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0;
      const batchTotal = readPositiveInteger(firstOptions.ocrBatchTotal) || progress.total;
      const pageIndex = readPositiveInteger(pageOptions.ocrPageIndex) || completedBefore + progress.index;
      const pageTotal = readPositiveInteger(pageOptions.ocrPageTotal) || batchTotal;
      const completedCount = phase === "start"
        ? Math.max(0, completedBefore + progress.index - 1)
        : completedBefore + progress.index;
      emitRuntimeProgress(
        batchOptions,
        "ocr_running",
        `${pageIndex} / ${pageTotal} 페이지 Paddle OCR 분석 중`,
        phase === "start" ? "페이지 처리 시작" : `${progress.count}개 후보`,
        {
          progressCurrent: Math.min(pageTotal, completedCount),
          progressTotal: pageTotal,
          pageIndex,
          pageTotal
        }
      );
  };
  const progressPoller = createOcrBatchProgressFilePoller(progressPath, handleProgressLine);
  let stdout = "";
  let stderr = "";
  try {
    progressPoller.start();
    ({ stdout, stderr } = await runShellCommand(command, {
      timeoutMs: resolveOcrBboxTimeoutMs(items.length),
      env: buildOcrRuntimeEnv(batchOptions, runtime),
      signal: batchOptions.abortSignal,
      onOutput: handleProgressLine
    }));
  } finally {
    progressPoller.stop();
  }

  return normalizedOptions.map((options, index) => {
    const outputPath = items[index].output;
    let payload = null;
    if (existsSync(outputPath)) {
      payload = JSON.parse(readFileSync(outputPath, "utf8"));
    }
    if (!payload) {
      throw createDetailedError("OCR bbox batch command did not produce JSON.", {
        command,
        outputPath,
        stdoutPreview: truncateText(stdout, 2000),
        stderrPreview: truncateText(stderr, 2000)
      });
    }
    const hints = normalizeOcrBboxHintPayload(payload, options);
    return buildOcrBboxResult(hints, [{
        provider,
        command,
        outputPath,
        runtimeDir: runtime?.runtimeDir || null,
        runtimeVariant: runtime?.runtimeVariant || null,
        packageDir: runtime?.packageDir || null,
        pythonPath: runtime?.pythonPath || null,
        runtimePrepared: Boolean(runtime?.prepared),
        hintCount: hints.length,
        stdoutPreview: truncateText(stdout.trim(), 1200),
        stderrPreview: truncateText(stderr.trim(), 1200),
        runtimeDiagnostics: runtime?.diagnostics || []
      }]);
  });
}

async function ensurePaddleOcrRuntime(options = {}) {
  const diagnostics = [];
  const runtimeDir = resolveOcrRuntimeDir(options);
  const runtimeVariant = resolveOcrRuntimeVariant(options);
  const venvDir = path.join(runtimeDir, `.venv-${runtimeVariant}`);
  const venvPython = resolveVenvPythonPath(venvDir);
  const packageDir = resolveOcrPythonPackageDir(runtimeDir, options);
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(path.join(runtimeDir, "pip-cache"), { recursive: true });
  await mkdir(path.join(runtimeDir, "tmp"), { recursive: true });

  emitRuntimeProgress(options, "ocr_preparing", "Paddle OCR 런타임 확인 중", `${resolveOcrDeviceLabel(options)}, ${runtimeVariant}`);
  let importCheck = existsSync(venvPython)
    ? await checkPaddleOcrImport(venvPython, options, { runtimeDir, includePackageDir: false })
    : { ok: false, message: "venv python is missing" };
  if (existsSync(venvPython) && importCheck.ok) {
    if (hasOcrInstallMarker(packageDir, runtimeVariant, options)) {
      return finalizePaddleOcrRuntime(options, { runtimeDir, runtimeVariant, packageDir, pythonPath: venvPython, prepared: true, usesTargetPackageDir: false, diagnostics });
    }
    diagnostics.push({
      step: "venv-runtime-signature-mismatch",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: venvPython,
      expectedSignature: resolveOcrInstallSignature(options)
    });
    emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 런타임 재설치 중", "패키지 구성이 바뀌어 기존 OCR 런타임을 다시 준비합니다.", {
      progressMode: "log-only",
      installLogLine: "기존 OCR 런타임 패키지 구성이 현재 버전과 달라 재설치합니다."
    });
    await rm(venvDir, { recursive: true, force: true });
    await rm(packageDir, { recursive: true, force: true });
    importCheck = { ok: false, message: "OCR runtime package signature changed" };
  }

  const bootstrapPython = resolveBootstrapPython(options);
  if (!bootstrapPython) {
    throw new Error("PaddleOCR-VL bbox provider needs Python. Bundle tools/python/python.exe or set MANGA_TRANSLATOR_OCR_PYTHON.");
  }
  ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
  importCheck = !existsSync(venvPython)
    ? await checkPaddleOcrImport(bootstrapPython, options, { runtimeDir, packageDir, includePackageDir: true })
    : importCheck;
  if (!existsSync(venvPython) && importCheck.ok) {
    if (hasOcrInstallMarker(packageDir, runtimeVariant, options)) {
      return finalizePaddleOcrRuntime(options, { runtimeDir, runtimeVariant, packageDir, pythonPath: bootstrapPython, prepared: true, usesTargetPackageDir: true, diagnostics: [{ step: "embedded-python-ready", packageDir }] });
    }
    diagnostics.push({
      step: "target-runtime-signature-mismatch",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: bootstrapPython,
      expectedSignature: resolveOcrInstallSignature(options)
    });
    emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 런타임 재설치 중", "패키지 구성이 바뀌어 기존 OCR 런타임을 다시 준비합니다.", {
      progressMode: "log-only",
      installLogLine: "기존 OCR 런타임 패키지 구성이 현재 버전과 달라 재설치합니다."
    });
    await rm(packageDir, { recursive: true, force: true });
    ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
    importCheck = { ok: false, message: "OCR runtime package signature changed" };
  }

  const targetInstallLooksBroken = hasOcrInstallMarker(packageDir, runtimeVariant, options) || hasExpectedOcrPackages(packageDir, options);
  if (targetInstallLooksBroken && !importCheck.ok) {
    diagnostics.push({
      step: "installed-runtime-verification-failed",
      runtimeDir,
      runtimeVariant,
      packageDir,
      pythonPath: existsSync(venvPython) ? venvPython : bootstrapPython,
      importError: importCheck.message
    });
    await rm(packageDir, { recursive: true, force: true });
    ensureEmbeddedPythonPackagePath(bootstrapPython, packageDir, runtimeDir);
  }

  if (!isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_AUTO_INSTALL", options) ?? "true")) {
    throw new Error("PaddleOCR-VL runtime is not installed and automatic installation is disabled.");
  }

  diagnostics.push({ step: "bootstrap-python", pythonPath: bootstrapPython });
  if (!existsSync(venvPython)) {
    try {
      emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR Python 환경 생성 중", runtimeDir, {
        progressMode: "log-only",
        installLogLine: "Python 가상환경을 생성합니다."
      });
      await runShellCommand(`${quoteCommandArg(bootstrapPython)} -m venv ${quoteCommandArg(venvDir)}`, {
        timeoutMs: 180000,
        env: buildOcrRuntimeEnv(options, { runtimeDir, includePackageDir: false }),
        signal: options.abortSignal
      });
      diagnostics.push({ step: "venv-created", venvDir });
    } catch (error) {
      diagnostics.push({
        step: "venv-create-failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const installBatches = resolveOcrPipInstallBatches(options);
  const packageSummary = summarizeOcrInstallBatches(installBatches, options);
  let installPython = existsSync(venvPython) ? venvPython : bootstrapPython;
  let targetDir = existsSync(venvPython) ? null : packageDir;
  try {
    emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 패키지 다운로드/설치 중", packageSummary, {
      progressMode: "log-only",
      installLogLine: "Paddle OCR 패키지 설치를 시작합니다."
    });
    await installOcrPythonPackages(installPython, installBatches, targetDir, options, runtimeDir);
  } catch (error) {
    if (installPython === bootstrapPython) {
      throw error;
    }
    diagnostics.push({
      step: "venv-pip-install-failed",
      message: error instanceof Error ? error.message : String(error)
    });
    installPython = bootstrapPython;
    targetDir = packageDir;
    ensureEmbeddedPythonPackagePath(installPython, packageDir, runtimeDir);
    emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 패키지 재설치 중", packageSummary, {
      progressMode: "log-only",
      installLogLine: "가상환경 설치에 실패해 내장 Python 경로로 다시 설치합니다."
    });
    await installOcrPythonPackages(installPython, installBatches, targetDir, options, runtimeDir);
  }
  diagnostics.push({ step: "pip-installed", installBatches, targetDir, runtimeVariant });

  emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 설치 검증 중", packageSummary, {
    progressMode: "indeterminate",
    installLogLine: "Paddle OCR import와 장치 상태를 확인합니다."
  });
  importCheck = await checkPaddleOcrImport(installPython, options, {
    runtimeDir,
    packageDir,
    includePackageDir: Boolean(targetDir)
  });
  if (!importCheck.ok) {
    throw createOcrRuntimeError(
      buildPaddleOcrImportFailureMessage(importCheck.message, options),
      {
        step: "post-install-verification-failed",
        runtimeDir,
        runtimeVariant,
        packageDir,
        pythonPath: installPython,
        importError: importCheck.message
      },
      importCheck.error
    );
  }
  await writeOcrInstallMarker(packageDir, {
    runtimeVariant,
    installBatches,
    targetDir,
    packageSignature: resolveOcrInstallSignature(options),
    installedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString()
  });

  emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 설치 완료", packageSummary, {
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Paddle OCR 설치가 완료되었습니다."
  });

  return finalizePaddleOcrRuntime(options, { runtimeDir, runtimeVariant, packageDir, pythonPath: installPython, prepared: true, usesTargetPackageDir: Boolean(targetDir), diagnostics });
}

async function finalizePaddleOcrRuntime(options, runtime) {
  await ensurePaddleOcrModelAssetsDownloaded(options, runtime);
  return runtime;
}

function ensureEmbeddedPythonPackagePath(pythonPath, packageDir, runtimeDir = null) {
  if (!pythonPath || path.basename(pythonPath).toLowerCase() !== "python.exe") {
    return;
  }
  const pythonDir = path.dirname(path.resolve(pythonPath));
  let pthName = "";
  try {
    pthName = readdirSync(pythonDir).find((name) => /^python\d+._pth$/i.test(name)) || "";
  } catch {
    return;
  }
  if (!pthName) {
    return;
  }
  const pthPath = path.join(pythonDir, pthName);
  const normalizedPackageDir = path.resolve(packageDir);
  try {
    const text = readFileSync(pthPath, "utf8");
    const normalizedRuntimeDir = runtimeDir ? path.resolve(runtimeDir) : "";
    const lines = text.split(/\r?\n/);
    const nextLines = lines
      .filter((line) => !isManagedOcrPackagePathLine(line, pythonDir, normalizedRuntimeDir))
      .map((line) => line.trim() === "#import site" ? "import site" : line);
    const importSiteIndex = nextLines.findIndex((line) => line.trim() === "import site");
    if (importSiteIndex === -1) {
      nextLines.push(normalizedPackageDir, "import site");
    } else {
      nextLines.splice(importSiteIndex, 0, normalizedPackageDir);
    }
    const nextText = `${nextLines.filter((line, index, array) => index < array.length - 1 || line.trim()).join("\n")}\n`;
    if (nextText !== text) {
      writeFileSync(pthPath, nextText, "utf8");
    }
  } catch {
    // If the packaged Python directory is not writable, installation may still
    // work when packages are installed directly into its site-packages.
  }
}

function isManagedOcrPackagePathLine(line, pythonDir, runtimeDir) {
  const raw = String(line ?? "").trim();
  if (!raw || raw.startsWith("#")) {
    return false;
  }
  let resolved = raw;
  try {
    resolved = path.resolve(pythonDir, raw);
  } catch {
    return false;
  }
  const base = path.basename(resolved);
  if (!base.startsWith("python-packages")) {
    return false;
  }
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  const normalizedRuntimeDir = runtimeDir ? path.resolve(runtimeDir).replace(/\\/g, "/").toLowerCase() : "";
  return (
    (normalizedRuntimeDir && normalized.startsWith(normalizedRuntimeDir)) ||
    normalized.includes("/manga-gemma-translator/ocr-runtime/") ||
    normalized.includes("/mgt-ocr-runtime/") ||
    normalized.includes("/.tmp/ocr-runtime/")
  );
}

async function installOcrPythonPackages(pythonPath, installBatches, targetDir, options, runtimeDir) {
  const progressDir = runtimeDir || targetDir || resolveInstallProgressDir(pythonPath);
  const pipCacheDir = path.join(progressDir, "pip-cache");
  await mkdir(pipCacheDir, { recursive: true });
  await mkdir(path.join(progressDir, "tmp"), { recursive: true });
  const monitor = startTaskProgressMonitor(options, {
    phase: "ocr_downloading",
    progressText: "Paddle OCR 패키지 다운로드/설치 중",
    detailPrefix: summarizeOcrInstallBatches(installBatches, options),
    startPercent: 0.04,
    endPercent: 0.86
  });
  try {
    const pipProgressArgs = `--cache-dir ${quoteCommandArg(pipCacheDir)} --progress-bar raw`;
    monitor.setStep("pip 업데이트", 0.04, 0.1);
    await runShellCommand(`${quoteCommandArg(pythonPath)} -m pip install --upgrade ${pipProgressArgs} pip`, {
      timeoutMs: 300000,
      env: buildOcrRuntimeEnv(options, { runtimeDir, includePackageDir: false }),
      signal: options.abortSignal,
      onOutput: (line) => monitor.log(line)
    });
    monitor.completeStep("pip 업데이트 완료");
    const batchRanges = resolveOcrInstallBatchProgressRanges(installBatches, 0.1, 0.86);
    for (let index = 0; index < installBatches.length; index += 1) {
      const packages = installBatches[index];
      const range = batchRanges[index] || { start: 0.1, end: 0.86 };
      const start = range.start;
      const end = range.end;
      monitor.setStep(`패키지 설치 ${index + 1}/${installBatches.length}`, start, end);
      await runShellCommand(`${quoteCommandArg(pythonPath)} -m pip install --upgrade ${pipProgressArgs} ${targetDir ? `--target ${quoteCommandArg(targetDir)} ` : ""}${packages.map(quoteCommandArg).join(" ")}`, {
        timeoutMs: readPositiveInteger(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PIP_TIMEOUT_MS", options)) || 1800000,
        env: buildOcrRuntimeEnv(options, { runtimeDir, includePackageDir: false }),
        signal: options.abortSignal,
        onOutput: (line) => monitor.log(line)
      });
      monitor.completeStep(`패키지 설치 ${index + 1}/${installBatches.length} 완료`);
    }
  } finally {
    monitor.stop();
  }
}

function resolveOcrInstallBatchProgressRanges(installBatches, startPercent, endPercent) {
  const start = clampProgressRatio(startPercent, 0);
  const end = Math.max(start, clampProgressRatio(endPercent, start));
  const batches = Array.isArray(installBatches) ? installBatches : [];
  if (batches.length === 0) {
    return [];
  }

  const weights = batches.map((packages, index) => {
    const packageText = Array.isArray(packages) ? packages.join(" ").toLowerCase() : "";
    if (packageText.includes("safetensors")) {
      return batches.length > 1 ? 0.04 : 1;
    }
    if (packageText.includes("paddlepaddle")) {
      return batches.length > 1 ? 0.36 : 1;
    }
    if (packageText.includes("paddleocr") || packageText.includes("paddlex")) {
      return batches.length > 1 ? 0.64 : 1;
    }
    return 1 + index * 0;
  });
  const totalWeight = weights.reduce((sum, value) => sum + Math.max(0.01, value), 0) || 1;
  let cursor = start;
  return batches.map((_packages, index) => {
    const isLast = index === batches.length - 1;
    const next = isLast ? end : cursor + (end - start) * (Math.max(0.01, weights[index]) / totalWeight);
    const range = { start: cursor, end: next };
    cursor = next;
    return range;
  });
}

function resolveInstallProgressDir(pythonPath) {
  const resolved = path.resolve(String(pythonPath || ""));
  if (resolved.toLowerCase().endsWith(`${path.sep}scripts${path.sep}python.exe`)) {
    return path.dirname(path.dirname(resolved));
  }
  return path.dirname(resolved);
}

function resolveOcrRuntimeDir(options = {}) {
  return path.resolve(
    String(
      options.ocrRuntimeDir
        ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_RUNTIME_DIR", options)
        ?? path.join(options.workingDir || process.cwd(), "ocr-runtime")
    )
  );
}

function resolveVenvPythonPath(venvDir) {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function resolveBootstrapPython(options = {}) {
  const explicitCandidates = [
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PYTHON", options),
    runtimeOverrideEnv("MANGA_TRANSLATOR_PYTHON", options)
  ]
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean);

  for (const candidate of explicitCandidates) {
    if (candidate === "python" || existsSync(candidate)) {
      return candidate;
    }
  }

  const bundledCandidates = [
    path.join(options.toolsDir || "", "python", "python.exe"),
    path.join(options.toolsDir || "", "python", "python-embed", "python.exe"),
    path.join(options.toolsDir || "", "python.exe")
  ];

  for (const candidate of bundledCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  if (shouldAllowSystemPythonFallback(options)) {
    return "python";
  }
  return null;
}

function shouldAllowSystemPythonFallback(options = {}) {
  const explicit =
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ALLOW_SYSTEM_PYTHON", options) ??
    runtimeOverrideEnv("MANGA_TRANSLATOR_ALLOW_SYSTEM_PYTHON", options);
  if (explicit !== undefined) {
    return isTruthy(explicit);
  }
  return !isLikelyPackagedToolsDir(options.toolsDir);
}

function isLikelyPackagedToolsDir(toolsDir) {
  const text = String(toolsDir ?? "").trim();
  if (!text) {
    return false;
  }
  const normalized = path.resolve(text).replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith("/resources/tools") || normalized.includes("/resources/tools/");
}

function resolveOcrPipInstallBatches(options = {}) {
  const explicit = splitShellLikeEnv(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PIP_PACKAGES", options));
  if (explicit.length > 0) {
    return withPaddleOcrVlSafetensorsBatch([explicit]);
  }

  if (!isOcrGpuRequested(options)) {
    const cpuPackages = splitShellLikeEnv(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES", options));
    return withPaddleOcrVlSafetensorsBatch([cpuPackages.length > 0 ? cpuPackages : DEFAULT_OCR_CPU_PIP_PACKAGES]);
  }

  const gpuPackages = splitShellLikeEnv(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES", options));
  if (gpuPackages.length > 0) {
    return withPaddleOcrVlSafetensorsBatch([gpuPackages]);
  }

  return withPaddleOcrVlSafetensorsBatch([
    resolveOcrGpuPaddleInstallBatch(options),
    DEFAULT_OCR_GPU_EXTRA_PACKAGES
  ]);
}

function resolveOcrGpuPaddleInstallBatch(options = {}) {
  const explicitWheel = String(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_WHEEL", options) ?? "").trim();
  if (explicitWheel) {
    return [explicitWheel];
  }
  return [
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_PACKAGE", options) || DEFAULT_OCR_GPU_PADDLE_PACKAGE,
    "--index-url",
    resolveOcrGpuPackageIndexUrl(options)
  ];
}

function withPaddleOcrVlSafetensorsBatch(installBatches) {
  const batches = Array.isArray(installBatches) ? installBatches.map((batch) => Array.isArray(batch) ? [...batch] : []) : [];
  if (process.platform !== "win32") {
    return batches;
  }

  const safetensorsPackages = [];
  const normalizedBatches = batches
    .map((batch) => {
      const normalPackages = [];
      for (const item of batch) {
        const text = String(item ?? "").trim();
        if (!text) {
          continue;
        }
        if (/safetensors/i.test(text)) {
          safetensorsPackages.push(text);
          continue;
        }
        normalPackages.push(text);
      }
      return normalPackages;
    })
    .filter((batch) => batch.length > 0);

  const safetensorsBatch = [
    "--no-deps",
    "--force-reinstall",
    ...(safetensorsPackages.length > 0 ? safetensorsPackages : [PADDLEOCR_VL_WINDOWS_SAFETENSORS_WHEEL])
  ];
  return [...normalizedBatches, safetensorsBatch];
}

function splitShellLikeEnv(value) {
  const raw = String(value ?? "").trim();
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function summarizeOcrInstallBatches(installBatches, options = {}) {
  const packageNames = installBatches
    .flat()
    .filter((part) => !part.startsWith("-") && !/^https?:\/\//i.test(part));
  const suffix = isOcrGpuRequested(options) ? ` (${resolveOcrGpuCudaTag(options)})` : "";
  return `${packageNames.join(", ")}${suffix}`;
}

function isOcrGpuRequested(options = {}) {
  return resolveOcrDevice(options).startsWith("gpu");
}

function isOcrBlackwellCudaTag(options = {}) {
  return resolveOcrGpuCudaTag(options) === "cu129";
}

function resolveOcrGpuCudaTag(options = {}) {
  const raw = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", options)
      ?? runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG", options)
      ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA", options)
      ?? options.ocrGpuCudaTag
      ?? DEFAULT_OCR_GPU_CUDA_TAG
  ).trim().toLowerCase();
  if (/^cu\d+$/.test(raw)) {
    return raw;
  }
  const digits = raw.replace(/\D/g, "");
  return digits ? `cu${digits}` : DEFAULT_OCR_GPU_CUDA_TAG;
}

function resolveOcrGpuPackageIndexUrl(options = {}) {
  return String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL", options)
      ?? runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL", options)
      ?? `https://www.paddlepaddle.org.cn/packages/stable/${resolveOcrGpuCudaTag(options)}/`
  ).trim();
}

function resolveOcrRuntimeVariant(options = {}) {
  if (!isOcrGpuRequested(options)) {
    return "cpu";
  }
  return `gpu-${resolveOcrGpuCudaTag(options)}`.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
}

function resolveOcrPythonPackageDir(runtimeDir, options = {}) {
  return path.join(runtimeDir, `python-packages-${resolveOcrRuntimeVariant(options)}`);
}

function resolveOcrDevice(options = {}) {
  const explicitDevice = String(runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_DEVICE", options) ?? "").trim();
  if (explicitDevice) {
    return explicitDevice;
  }
  const value = String(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) ?? options.ocrDevice ?? "cpu").trim().toLowerCase();
  if (value === "gpu" || value === "cuda") {
    return "gpu:0";
  }
  if (value.startsWith("gpu")) {
    return value;
  }
  return "cpu";
}

function resolveOcrDeviceLabel(options = {}) {
  const device = resolveOcrDevice(options);
  return device === "cpu" ? "CPU" : device.toUpperCase();
}

function emitRuntimeProgress(options = {}, phase, progressText, detail, progress = {}) {
  if (typeof options.onProgress !== "function") {
    return;
  }
  try {
    options.onProgress({ phase, progressText, detail, ...progress });
  } catch {
    // Progress reporting must never interrupt translation.
  }
}

async function canImportPaddleOcr(pythonPath, options = {}) {
  return (await checkPaddleOcrImport(pythonPath, options)).ok;
}

async function checkPaddleOcrImport(pythonPath, options = {}, runtime = null) {
  try {
    await runShellCommand(`${quoteCommandArg(pythonPath)} -c ${quoteCommandArg(buildPaddleOcrImportCheckScript(options))}`, {
      timeoutMs: resolvePaddleOcrImportCheckTimeoutMs(options),
      env: buildOcrRuntimeEnv(options, {
        runtimeDir: runtime?.runtimeDir || resolveOcrRuntimeDir(options),
        packageDir: runtime?.packageDir,
        includePackageDir: runtime?.includePackageDir
      }),
      signal: options.abortSignal,
      timeoutMessage: "Paddle OCR runtime verification timed out."
    });
    return { ok: true, message: "" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      error
    };
  }
}

function resolvePaddleOcrImportCheckTimeoutMs(options = {}) {
  const explicit = readPositiveInteger(process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS);
  if (explicit) {
    return explicit;
  }
  if (isOcrGpuRequested(options)) {
    return isOcrBlackwellCudaTag(options) ? 300000 : 180000;
  }
  return 120000;
}

function buildPaddleOcrImportFailureMessage(importMessage, options = {}) {
  if (isPaddleSm120UnsupportedText(importMessage)) {
    return buildPaddleOcrSm120FailureMessage(importMessage, options);
  }
  if (isPaddleBfloat16SafetensorsText(importMessage)) {
    return buildPaddleOcrBfloat16SafetensorsFailureMessage(importMessage, options);
  }
  if (isPaddleOcrVerificationTimeoutText(importMessage)) {
    const suffix = isOcrGpuRequested(options)
      ? ` GPU 검증이 제한 시간 안에 끝나지 않았습니다. RTX 50번대는 cu129 런타임을 사용하며 첫 실행 검증이 오래 걸릴 수 있지만, 반복되면 NVIDIA 드라이버/CUDA 12.9용 Paddle 런타임 호환성을 확인해야 합니다.`
      : " CPU 런타임 검증이 제한 시간 안에 끝나지 않았습니다.";
    return `Paddle OCR 런타임 설치 후 검증이 시간 초과되었습니다.${suffix} detail=${truncateText(importMessage, 1200)}`;
  }
  const suffix = isOcrGpuRequested(options)
    ? " GPU를 선택했지만 GPU Paddle/CUDA 검증에 실패했습니다. CPU로 바꾸거나 CUDA 드라이버와 GPU Paddle wheel을 확인하세요."
    : "";
  const detail = importMessage ? ` detail=${truncateText(importMessage, 1200)}` : "";
  return `PaddleOCR-VL runtime was installed but paddleocr/paddlex/paddle imports still fail.${suffix}${detail}`;
}

function buildPaddleOcrGpuFailureMessage(error, options = {}) {
  const text = summarizeOcrErrorMessage(error);
  if (isPaddleSm120UnsupportedText(text)) {
    return buildPaddleOcrSm120FailureMessage(text, options);
  }
  if (isPaddleBfloat16SafetensorsText(text)) {
    return buildPaddleOcrBfloat16SafetensorsFailureMessage(text, options);
  }
  return `Paddle OCR GPU 실행에 실패했습니다. GPU 설정을 쓰려면 CUDA가 보이는 GPU Paddle 런타임이 필요합니다. CPU로 바꾸면 계속 진행할 수 있습니다. detail=${truncateText(text, 1200)}`;
}

function buildPaddleOcrSm120FailureMessage(detail, options = {}) {
  return `RTX 50번대/SM120에서 현재 Paddle OCR GPU 런타임이 맞지 않습니다. RTX 50번대는 CUDA 12.9용 Paddle OCR 런타임(cu129)을 사용해야 합니다. 설정값은 현재 ${resolveOcrGpuCudaTag(options)}입니다. 기존 gpu-cu126 런타임이 남아 있으면 OCR 런타임을 삭제하고 다시 시도하세요. detail=${truncateText(detail, 1200)}`;
}

function buildPaddleOcrBfloat16SafetensorsFailureMessage(detail, options = {}) {
  return `PaddleOCR-VL 모델 가중치(bfloat16)를 현재 OCR 런타임이 읽지 못했습니다. Windows에서는 PaddleOCR-VL용 special safetensors 휠과 공식 ${resolveOcrGpuCudaTag(options)} Paddle 런타임이 같이 필요합니다. OCR 런타임 패키지가 다시 설치되도록 앱을 업데이트한 뒤 재시도하세요. detail=${truncateText(detail, 1200)}`;
}

function isPaddleSm120UnsupportedText(value) {
  return /not compiled for\s+SM\s*120|sm[_\s-]*120|compute capability:\s*12(?:\.0)?|mismatched gpu architecture/i.test(String(value ?? ""));
}

function isPaddleBfloat16SafetensorsText(value) {
  return /data type ['"]?bfloat16['"]? not understood|_load_part_state_dict_from_safetensors/i.test(String(value ?? ""));
}

function isPaddleOcrVerificationTimeoutText(value) {
  return /Paddle OCR runtime verification timed out|OCR bbox command timed out/i.test(String(value ?? ""));
}

function summarizeOcrErrorMessage(error) {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const parts = [
    error.message,
    error.stderrPreview,
    error.stdoutPreview,
    error.cause instanceof Error ? error.cause.message : error.cause
  ].filter(Boolean);
  return parts.length > 0 ? parts.map((part) => String(part)).join(" ") : String(error);
}

function createOcrRuntimeError(message, detail = {}, cause) {
  return createDetailedError(
    message,
    {
      ...detail,
      nonRetriable: true,
      failureCategory: "ocr-runtime"
    },
    cause
  );
}

function hasOcrInstallMarker(packageDir, runtimeVariant, options = {}) {
  try {
    const marker = JSON.parse(readFileSync(path.join(packageDir, OCR_INSTALL_MARKER_FILE), "utf8"));
    return marker?.runtimeVariant === runtimeVariant && marker?.packageSignature === resolveOcrInstallSignature(options);
  } catch {
    return false;
  }
}

function resolveOcrInstallSignature(options = {}) {
  return resolveOcrPipInstallBatches(options)
    .map((batch) => batch.join(" "))
    .join(" | ");
}

async function writeOcrInstallMarker(packageDir, payload) {
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, OCR_INSTALL_MARKER_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function hasExpectedOcrPackages(packageDir, options = {}) {
  if (!packageDir || !existsSync(packageDir)) {
    return false;
  }
  const required = ["paddle", "paddleocr", "paddlex"];
  if (isOcrGpuRequested(options)) {
    required.push("nvidia");
  }
  return required.every((name) => existsSync(path.join(packageDir, name)));
}

function startTaskProgressMonitor(options = {}, config = {}) {
  const phase = config.phase || "ocr_downloading";
  const progressText = config.progressText || "설치 중";
  const detailPrefix = config.detailPrefix || "";
  let stepText = "";
  let stepStart = clampProgressRatio(config.startPercent, 0);
  let stepEnd = clampProgressRatio(config.endPercent, 0.95);
  let lastRatio = stepStart;
  let stopped = false;

  const emit = (extra = {}) => {
    if (stopped) {
      return;
    }
    const detail = [detailPrefix, stepText].filter(Boolean).join(" · ");
    emitRuntimeProgress(options, phase, progressText, detail, {
      progressMode: "log-only",
      ...extra
    });
  };

  emit({ installLogLine: "설치 작업을 시작합니다." });
  return {
    setStep(text, startPercent, endPercent) {
      stepText = text;
      stepStart = Math.max(lastRatio, clampProgressRatio(startPercent, lastRatio));
      stepEnd = Math.max(stepStart, clampProgressRatio(endPercent, stepStart));
      emit({ progressMode: "indeterminate", installLogLine: text });
    },
    completeStep(text = "") {
      lastRatio = Math.max(lastRatio, stepEnd);
      emit({
        progressMode: "determinate",
        progressPercent: lastRatio,
        installLogLine: text || `${stepText} 완료`
      });
    },
    log(line) {
      const logLine = sanitizeInstallLogLine(line);
      if (!logLine) {
        return;
      }
      const pipProgress = parsePipRawProgress(logLine);
      if (pipProgress) {
        emit({
          progressMode: "indeterminate",
          progressBytes: pipProgress.current,
          progressTotalBytes: pipProgress.total,
          installLogLine: `${stepText}: 현재 다운로드 ${formatBytes(pipProgress.current)} / ${formatBytes(pipProgress.total)}`
        });
        return;
      }
      emit({ progressMode: "indeterminate", installLogLine: logLine });
    },
    stop(finalProgress = null) {
      stopped = true;
      if (finalProgress) {
        emitRuntimeProgress(options, phase, progressText, finalProgress.detail, finalProgress);
      }
    }
  };
}

function createOcrCommandProgressHandler(options = {}, config = {}) {
  let lastDetail = "";
  let lastAt = 0;
  return (line) => {
    const logLine = sanitizeInstallLogLine(line);
    if (!logLine || parseOcrBatchProgressLine(logLine)) {
      return;
    }

    const fetchProgress = parsePaddleModelFetchProgress(logLine);
    const isModelStatusLine = Boolean(fetchProgress) ||
      /^(Creating model:|Checking connectivity|Using official model|Fetching \d+ files:)/i.test(logLine);
    if (!isModelStatusLine) {
      return;
    }

    const detail = fetchProgress
      ? formatPaddleModelFetchProgress(fetchProgress)
      : logLine;
    const now = Date.now();
    if (detail === lastDetail && now - lastAt < 2000) {
      return;
    }
    lastDetail = detail;
    lastAt = now;

    emitRuntimeProgress(options, "ocr_running", config.progressText || "Paddle OCR 모델 다운로드/위치 분석 중", detail, {
      progressMode: "log-only",
      progressCurrent: config.progressCurrent,
      progressTotal: config.progressTotal,
      installLogLine: logLine
    });
  };
}

function buildPaddleOcrImportCheckScript(options = {}) {
  const device = resolveOcrDevice(options);
  const lines = [
    "import importlib.util",
    "missing = [name for name in ('paddle', 'paddlex', 'paddleocr') if importlib.util.find_spec(name) is None]",
    "assert not missing, 'Missing Paddle OCR package(s): ' + ', '.join(missing)",
    "import paddle",
    "from paddleocr import PaddleOCRVL, PaddleOCR"
  ];
  if (device.startsWith("gpu")) {
    lines.push("assert paddle.device.is_compiled_with_cuda(), 'PaddlePaddle is not compiled with CUDA'");
    lines.push("count = paddle.device.cuda.device_count()");
    lines.push("assert count > 0, 'No CUDA device is visible to PaddlePaddle'");
    lines.push(`paddle.set_device(${JSON.stringify(device)})`);
  }
  return lines.join("; ");
}

function buildOcrRuntimeEnv(options = {}, runtime = null) {
  const runtimeDir = runtime?.runtimeDir || resolveOcrRuntimeDir(options);
  const hfHomeDir = options.hfHomeDir || runtimeOverrideEnv("HF_HOME", options) || path.join(runtimeDir, "hf-cache");
  const hfHubCacheDir =
    options.hfHubCacheDir ||
    runtimeOverrideEnv("HF_HUB_CACHE", options) ||
    runtimeOverrideEnv("HUGGINGFACE_HUB_CACHE", options) ||
    path.join(hfHomeDir, "hub");
  const packageDir = runtime?.packageDir || resolveOcrPythonPackageDir(runtimeDir, options);
  const includePackageDir = runtime?.includePackageDir ?? runtime?.usesTargetPackageDir ?? true;
  const pythonPath = includePackageDir ? packageDir : "";
  const ocrDevice = resolveOcrDevice(options);
  const pipCacheDir = path.join(runtimeDir, "pip-cache");
  const tempDir = path.join(runtimeDir, "tmp");
  const env = buildWhitelistedChildEnv({
    pathDirs: buildOcrRuntimePathDirs(options, runtime, runtimeDir),
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: [...NETWORK_CHILD_ENV_KEYS, ...HF_CHILD_ENV_KEYS]
  });
  return {
    ...env,
    HF_HOME: hfHomeDir,
    HF_HUB_CACHE: hfHubCacheDir,
    HUGGINGFACE_HUB_CACHE: hfHubCacheDir,
    HF_HUB_DISABLE_XET: runtimeOverrideEnv("HF_HUB_DISABLE_XET", options) || "1",
    HF_HUB_ETAG_TIMEOUT: runtimeOverrideEnv("HF_HUB_ETAG_TIMEOUT", options) || "30",
    HF_HUB_DOWNLOAD_TIMEOUT: runtimeOverrideEnv("HF_HUB_DOWNLOAD_TIMEOUT", options) || "300",
    MANGA_TRANSLATOR_OCR_DEVICE: options.ocrDevice || runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) || "cpu",
    MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG: resolveOcrGpuCudaTag(options),
    MANGA_TRANSLATOR_PADDLEOCR_DEVICE: ocrDevice,
    PYTHONPATH: pythonPath,
    PYTHONNOUSERSITE: "1",
    PYTHONUSERBASE: path.join(runtimeDir, "python-user-base"),
    PIP_CACHE_DIR: pipCacheDir,
    PADDLE_PDX_MODEL_SOURCE: runtimeOverrideEnv("PADDLE_PDX_MODEL_SOURCE", options) || "huggingface",
    PADDLE_PDX_CACHE_HOME: runtimeOverrideEnv("PADDLE_PDX_CACHE_HOME", options) || path.join(runtimeDir, "paddlex-cache"),
    PADDLE_PDX_HUGGING_FACE_ENDPOINT: runtimeOverrideEnv("PADDLE_PDX_HUGGING_FACE_ENDPOINT", options) || "https://huggingface.co",
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: runtimeOverrideEnv("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", options) || "True",
    PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT: runtimeOverrideEnv("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", options) || "0",
    PIP_DISABLE_PIP_VERSION_CHECK: runtimeOverrideEnv("PIP_DISABLE_PIP_VERSION_CHECK", options) || "1",
    TMP: tempDir,
    TEMP: tempDir,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1"
  };
}

function buildOcrRuntimePathDirs(options = {}, runtime = null, runtimeDir = resolveOcrRuntimeDir(options)) {
  const variant = resolveOcrRuntimeVariant(options);
  const venvBinDir = process.platform === "win32"
    ? path.join(runtimeDir, `.venv-${variant}`, "Scripts")
    : path.join(runtimeDir, `.venv-${variant}`, "bin");
  const toolsDir = resolveToolsDir(options);
  return [
    runtime?.pythonPath ? path.dirname(runtime.pythonPath) : null,
    venvBinDir,
    path.join(toolsDir || "", "python"),
    path.join(toolsDir || "", "python", "python-embed"),
    runtimeDir
  ];
}

function buildLlamaServerEnv(serverPath, options = {}) {
  const env = buildWhitelistedChildEnv({
    pathDirs: [path.dirname(serverPath)],
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: [...NETWORK_CHILD_ENV_KEYS, ...HF_CHILD_ENV_KEYS]
  });
  const hfHomeDir = resolveHfHomeDir(options);
  const hfHubCacheDir = resolveHubCacheDir(options);
  const llamaCacheDir = resolveLlamaCppCacheDir(options);
  if (hfHomeDir) {
    env.HF_HOME = hfHomeDir;
  }
  if (hfHubCacheDir) {
    env.HF_HUB_CACHE = hfHubCacheDir;
    env.HUGGINGFACE_HUB_CACHE = hfHubCacheDir;
  }
  if (llamaCacheDir) {
    try {
      mkdirSync(llamaCacheDir, { recursive: true });
    } catch {
      // llama-server can still use its own fallback if the cache directory cannot be created.
    }
    env.LLAMA_CACHE = llamaCacheDir;
    env.LLAMA_CACHE_DIR = llamaCacheDir;
  }
  env.MANGA_TRANSLATOR_LLAMA_PORT = String(options.port);
  return env;
}

function buildOcrBboxCommand(options = {}, provider, outputPath, runtime = null) {
  const template = String(options.ocrBboxCommand ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_CMD", options) ?? "").trim();
  const image = options.imagePath;
  const replacements = {
    image: quoteCommandArg(image),
    output: quoteCommandArg(outputPath)
  };

  if (template) {
    return renderCommandTemplate(template, replacements);
  }

  if (provider === "paddleocr-vl") {
    const python = quoteCommandArg(resolveOcrRuntimePythonPath(runtime, options));
    const scriptPath = quoteCommandArg(path.join(__dirname, "paddleocr-vl-bboxes.py"));
    return `${python} -u ${scriptPath} --image ${quoteCommandArg(image)} --output ${quoteCommandArg(outputPath)} --device ${quoteCommandArg(resolveOcrDevice(options))}`;
  }

  throw new Error("OCR bbox provider requires MANGA_TRANSLATOR_OCR_BBOX_CMD.");
}

function buildOcrBboxBatchCommand(options = {}, batchPath, runtime = null, progressPath = null) {
  const python = quoteCommandArg(resolveOcrRuntimePythonPath(runtime, options));
  const scriptPath = quoteCommandArg(path.join(__dirname, "paddleocr-vl-bboxes.py"));
  const progressArg = progressPath ? ` --progress ${quoteCommandArg(progressPath)}` : "";
  return `${python} -u ${scriptPath} --batch ${quoteCommandArg(batchPath)}${progressArg} --device ${quoteCommandArg(resolveOcrDevice(options))}`;
}

function resolveOcrRuntimePythonPath(runtime = null, options = {}) {
  if (runtime?.pythonPath) {
    return runtime.pythonPath;
  }
  const pythonPath = resolveBootstrapPython(options);
  if (pythonPath) {
    return pythonPath;
  }
  throw new Error("PaddleOCR-VL bbox provider needs an isolated Python runtime.");
}

function renderCommandTemplate(template, replacements) {
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}

function quoteCommandArg(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '\\"')}"`;
}

function withoutPageProgressOptions(options = {}) {
  const next = { ...options };
  delete next.ocrPageIndex;
  delete next.ocrPageTotal;
  delete next.ocrProgressDefaultToPage;
  delete next.pageIndex;
  delete next.pageTotal;
  return next;
}

function runShellCommand(command, { timeoutMs, env, signal, onOutput, timeoutMessage } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: env || buildUtilityChildEnv({})
    });
    let stdout = "";
    let stderr = "";
    let timeout = null;
    let settled = false;
    const stdoutLines = createCommandOutputLineEmitter(onOutput);
    const stderrLines = createCommandOutputLineEmitter(onOutput);

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
    };

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const settleResolve = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const onAbort = () => {
      terminateChildProcessTree(child);
      settleReject(createAbortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        terminateChildProcessTree(child);
        settleReject(createDetailedError(timeoutMessage || "OCR bbox command timed out.", { command, timeoutMs, stdoutPreview: truncateText(stdout), stderrPreview: truncateText(stderr) }));
      }, timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 30000);
      stdoutLines.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 30000);
      stderrLines.write(chunk);
    });
    child.on("error", (error) => {
      stdoutLines.flush();
      stderrLines.flush();
      settleReject(error);
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      stdoutLines.flush();
      stderrLines.flush();
      if (code === 0) {
        settleResolve({ stdout, stderr });
        return;
      }
      settleReject(createDetailedError(`OCR bbox command failed (${code ?? "null"}).`, {
        command,
        stdoutPreview: truncateText(stdout),
        stderrPreview: truncateText(stderr)
      }));
    });
  });
}

function createCommandOutputLineEmitter(onOutput) {
  let pending = "";
  const emitLine = (line) => {
    if (typeof onOutput !== "function") {
      return;
    }
    const sanitized = sanitizeInstallLogLine(line);
    if (sanitized) {
      onOutput(sanitized);
    }
  };

  return {
    write(chunk) {
      if (typeof onOutput !== "function") {
        return;
      }
      pending += String(chunk ?? "").replace(/\u001b\[[0-9;]*m/g, "");
      while (pending.length > 0) {
        const newlineIndex = pending.search(/[\r\n]/);
        if (newlineIndex < 0) {
          if (pending.length > 8192) {
            emitLine(pending.slice(0, 8192));
            pending = pending.slice(8192);
          }
          return;
        }

        const line = pending.slice(0, newlineIndex);
        let nextIndex = newlineIndex + 1;
        if (pending[newlineIndex] === "\r" && pending[nextIndex] === "\n") {
          nextIndex += 1;
        }
        pending = pending.slice(nextIndex);
        emitLine(line);
      }
    },
    flush() {
      if (!pending) {
        return;
      }
      emitLine(pending);
      pending = "";
    }
  };
}

function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function terminateChildProcessTree(child) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      env: buildUtilityChildEnv({})
    });
    killer.on("error", () => {
      child.kill("SIGKILL");
    });
    killer.on("close", (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    });
    return;
  }

  child.kill("SIGKILL");
}

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

async function isReachable(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReadyOrExit(baseUrl, child, timeoutMs = 1800000, signal = null) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`llama-server exited before becoming ready (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`);
    }
    if (await isReachable(baseUrl)) {
      return;
    }
    await delay(1500);
  }
  throw new Error(`Timed out while waiting for llama-server at ${baseUrl}`);
}

function shrinkBuffer(current, chunk, maxLength = 12000) {
  const next = `${current}${String(chunk)}`;
  return next.length <= maxLength ? next : next.slice(next.length - maxLength);
}

async function startServer(options) {
  const baseUrl = `http://127.0.0.1:${options.port}/v1`;
  if (options.reuseServer && shouldAllowExistingLlamaServerReuse(options) && await isReachable(baseUrl)) {
    return { baseUrl, child: null, startedByScript: false };
  }

  const explicitServerPath =
    runtimeOverrideEnv("MANGA_TRANSLATOR_LLAMA_SERVER_PATH", options) ||
    runtimeOverrideEnv("LLAMA_SERVER_PATH", options);
  const configuredServerPath = options.serverPath || defaultServerPath(options);
  const requestedServerPath =
    explicitServerPath || (isServerRuntimeCompatibleWithModel(configuredServerPath, options) ? configuredServerPath : defaultServerPath(options));
  if (!requestedServerPath || !existsSync(requestedServerPath) || isIncompleteManagedLlamaRuntime(requestedServerPath, options)) {
    await ensureDefaultLlamaRuntimeDownloaded(options);
  }
  const resolvedBundledServerPath = defaultServerPath(options);
  const serverPath = requestedServerPath && existsSync(requestedServerPath)
    ? requestedServerPath
    : resolvedBundledServerPath;
  if (!existsSync(serverPath)) {
    throw createDetailedError("Bundled llama-server binary is missing.", {
      baseUrl,
      serverPath,
      requestedServerPath,
      toolsDir: resolveToolsDir(options),
      checkedServerPaths: bundledServerCandidates(resolveToolsDir(options)),
      optionSummary: buildOptionSummary(options)
    });
  }

  await verifyLlamaRuntimePreflight(serverPath, options);
  const childEnv = buildLlamaServerEnv(serverPath, options);

  let launchTarget = inspectModelLaunch(options);
  if (launchTarget.requiresDownload) {
    await ensureHfModelAssetsDownloaded(options, launchTarget);
    launchTarget = inspectModelLaunch(options);
  }
  const launchArgs = buildLaunchArgs(options);
  const serverLogStream = createServerLogStream(options, serverPath, launchArgs);
  emitRuntimeProgress(options, "booting", "Gemma 서버 시작 중", `${resolveConfiguredModelFile(options)} 로드 중`, {
    progressMode: "indeterminate",
    installLogLine: "llama-server를 시작합니다."
  });
  let recentStdout = "";
  let recentStderr = "";
  const child = spawn(serverPath, launchArgs, {
    cwd: resolveWorkingDir(options),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: childEnv
  });
  const abortSignal = options.abortSignal;
  const onAbort = () => terminateChildProcessTree(child);
  abortSignal?.addEventListener?.("abort", onAbort, { once: true });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    recentStdout = shrinkBuffer(recentStdout, chunk);
    serverLogStream?.write(`[stdout] ${chunk}`);
    emitServerInstallLog(options, chunk);
    process.stdout.write(`[llama:${options.label}:stdout] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    recentStderr = shrinkBuffer(recentStderr, chunk);
    serverLogStream?.write(`[stderr] ${chunk}`);
    emitServerInstallLog(options, chunk);
    process.stderr.write(`[llama:${options.label}:stderr] ${chunk}`);
  });
  child.once("exit", () => serverLogStream?.end());
  child.once("error", () => serverLogStream?.end());

  try {
    await Promise.race([
      waitForReadyOrExit(baseUrl, child, 1800000, abortSignal),
      new Promise((_, reject) => {
        child.once("error", (error) => {
          reject(
            createDetailedError(
              "Failed to launch llama-server.",
              {
                baseUrl,
                serverPath,
                launchArgs,
                optionSummary: buildOptionSummary(options),
                recentStdout: truncateText(recentStdout.trim(), 4000),
                recentStderr: truncateText(recentStderr.trim(), 4000)
              },
              error
            )
          );
        });
      })
    ]);
    emitRuntimeProgress(options, "booting", "Gemma 서버 준비 완료", `${resolveConfiguredModelFile(options)} 준비 완료`, {
      progressMode: "determinate",
      progressPercent: 1,
      installLogLine: "Gemma 서버 준비가 완료되었습니다."
    });
  } catch (error) {
    terminateChildProcessTree(child);
    if (error?.name === "AbortError" || abortSignal?.aborted) {
      throw createAbortError();
    }
    if (error instanceof Error && (error.serverPath || error.baseUrl || error.optionSummary)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw createDetailedError(
      message,
      {
        baseUrl,
        serverPath,
        launchArgs,
        optionSummary: buildOptionSummary(options),
        recentStdout: truncateText(recentStdout.trim(), 4000),
        recentStderr: truncateText(recentStderr.trim(), 4000)
      },
      error
    );
  } finally {
    abortSignal?.removeEventListener?.("abort", onAbort);
  }

  return { baseUrl, child, startedByScript: true, serverLogPath: options.serverLogPath };
}

function shouldAllowExistingLlamaServerReuse(options = {}) {
  return isTruthy(runtimeOverrideEnv("MGT_ALLOW_LLAMA_SERVER_REUSE", options) ?? runtimeOverrideEnv("MANGA_TRANSLATOR_ALLOW_LLAMA_SERVER_REUSE", options));
}

function isIncompleteManagedLlamaRuntime(serverPath, options = {}) {
  if (!serverPath || !isBuiltInGemmaRuntimeModel(options)) {
    return false;
  }
  const preferredRuntime = resolvePreferredLlamaRuntime(options);
  const runtimeDir = path.dirname(serverPath);
  if (path.basename(runtimeDir).toLowerCase() !== preferredRuntime.dir.toLowerCase()) {
    return false;
  }
  return !hasRequiredLlamaRuntimeFiles(runtimeDir, preferredRuntime);
}

async function verifyLlamaRuntimePreflight(serverPath, options = {}) {
  if (!looksLikeGemma4Model(options)) {
    return;
  }
  const preferredRuntime = resolvePreferredLlamaRuntime(options);
  const runtimeDir = path.dirname(serverPath);
  if (path.basename(runtimeDir).toLowerCase() === preferredRuntime.dir.toLowerCase()) {
    const missingFiles = missingRequiredLlamaRuntimeFiles(runtimeDir, preferredRuntime);
    if (missingFiles.length > 0) {
      throw createDetailedError("Gemma 실행 런타임이 불완전합니다. CUDA DLL을 포함해 다시 설치해야 합니다.", {
        serverPath,
        runtimeDir,
        runtime: preferredRuntime.id,
        missingFiles
      });
    }
  }
  if (process.platform !== "win32" || runtimeOverrideEnv("MGT_SKIP_LLAMA_RUNTIME_PREFLIGHT", options)) {
    return;
  }
  const result = await runLlamaRuntimeProbe(serverPath, options, ["--list-devices"], 20000);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    throw createDetailedError("llama-server CUDA 런타임 검증에 실패했습니다.", {
      serverPath,
      code: result.code,
      stdout: truncateText(result.stdout, 4000),
      stderr: truncateText(result.stderr, 4000)
    });
  }
  if (!/(cuda|nvidia|geforce|rtx|gpu)/i.test(output)) {
    throw createDetailedError("llama-server가 CUDA GPU를 찾지 못했습니다. CPU 실행으로 조용히 넘어가지 않도록 중단합니다.", {
      serverPath,
      stdout: truncateText(result.stdout, 4000),
      stderr: truncateText(result.stderr, 4000)
    });
  }
}

function runLlamaRuntimeProbe(serverPath, options = {}, args = [], timeoutMs = 20000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(serverPath, args, {
      cwd: resolveWorkingDir(options),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: buildLlamaServerEnv(serverPath, options)
    });
    const timer = setTimeout(() => {
      terminateChildProcessTree(child);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\nllama-server probe timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = shrinkBuffer(stdout, chunk, 8000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = shrinkBuffer(stderr, chunk, 8000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
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

function createServerLogStream(options, serverPath, launchArgs) {
  const logPath = String(options.serverLogPath ?? "").trim();
  if (!logPath) {
    return null;
  }
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const stream = createWriteStream(logPath, { flags: "a" });
    stream.write(`# ${new Date().toISOString()}\n`);
    stream.write(`# serverPath=${serverPath}\n`);
    stream.write(`# launchArgs=${launchArgs.join(" ")}\n`);
    return stream;
  } catch {
    return null;
  }
}

function emitServerInstallLog(options = {}, chunk) {
  for (const part of String(chunk ?? "").split(/[\r\n]+/)) {
    const line = sanitizeInstallLogLine(part);
    if (!line) {
      continue;
    }
    emitRuntimeProgress(options, "booting", "Gemma 서버 로그", `${resolveConfiguredModelFile(options)} 실행 중`, {
      progressMode: "log-only",
      installLogLine: line
    });
  }
}

async function stopServer(server) {
  if (!server?.child) {
    return;
  }
  const child = server.child;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  if (process.platform === "win32") {
    terminateChildProcessTree(child);
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000)
  ]);
  if (!exited) {
    terminateChildProcessTree(child);
  }
}

async function requestTranslation(server, options) {
  const requestStartedAt = nowMs();
  const ocrBboxResult = await collectOcrBboxHints(options);
  const promptOptions = {
    ...options,
    ocrBboxHints: ocrBboxResult.hints
  };

  if (ocrBboxResult.noTextDetected) {
    const systemPrompt = buildSystemPrompt(promptOptions);
    const requestSummary = buildRequestSummary(server, promptOptions, [], "", systemPrompt);
    requestSummary.noTextDetected = true;
    requestSummary.ocrTextEvidenceCount = ocrBboxResult.textEvidenceCount;
    if (ocrBboxResult.diagnostics.length > 0) {
      requestSummary.ocrBboxDiagnostics = ocrBboxResult.diagnostics;
    }
    emitRuntimeProgress(promptOptions, "page_done", "페이지 텍스트 없음", "Paddle OCR에서 일본어 텍스트 근거를 찾지 못해 모델 호출을 생략했습니다.");
    return {
      requestBody: requestSummary,
      rawResponse: {
        skipped: true,
        reason: "ocr-no-text",
        noTextDetected: true,
        textEvidenceCount: ocrBboxResult.textEvidenceCount
      },
      outputText: "{\"items\":[]}"
    };
  }

  const preparedVariants = await prepareImageVariants(options);
  const imageVariants = preparedVariants.imageVariants;
  const promptText = promptOptions.promptOverrideText || getOverlayPrompt(promptOptions, imageVariants);
  const systemPrompt = buildSystemPrompt(promptOptions);
  const requestBody = isOpenAICodexProvider(options)
    ? buildResponsesRequestBody(promptOptions, imageVariants, promptText, systemPrompt)
    : buildChatRequestBody(promptOptions, buildMessages(promptOptions, imageVariants));
  const requestSummary = buildRequestSummary(server, promptOptions, imageVariants, promptText, systemPrompt);
  requestSummary.noTextDetected = false;
  requestSummary.ocrTextEvidenceCount = ocrBboxResult.textEvidenceCount;
  if (preparedVariants.diagnostics.length > 0) {
    requestSummary.imageVariantDiagnostics = preparedVariants.diagnostics;
  }
  if (ocrBboxResult.diagnostics.length > 0) {
    requestSummary.ocrBboxDiagnostics = ocrBboxResult.diagnostics;
  }

  if (isOpenAICodexProvider(options)) {
    emitRuntimeProgress(promptOptions, "model_requesting", "OpenAI Codex 번역 요청 중", `${resolveConfiguredCodexModel(promptOptions)}, thinking ${resolveConfiguredCodexReasoningEffort(promptOptions)}`);
    const finalResult = await requestCodexResponsesText(server, promptOptions, requestBody, requestSummary);
    return {
      requestBody: requestSummary,
      rawResponse: finalResult.rawResponse,
      outputText: finalResult.outputText
    };
  }

  let response;
  try {
    emitRuntimeProgress(promptOptions, "model_requesting", "Gemma 4 번역 요청 중", resolveRequestModelName(promptOptions));
    response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(promptOptions),
      body: JSON.stringify(requestBody),
      signal: promptOptions.abortSignal
    });
  } catch (error) {
    throw createDetailedError(`${resolveProviderDisplayName(promptOptions)} request transport failed.`, { requestSummary }, error);
  }

  let rawText = "";
  rawText = await readResponseText(response, requestSummary, promptOptions);
  requestSummary.performance = {
    wallMs: Math.round(nowMs() - requestStartedAt),
    provider: resolveProviderDisplayName(promptOptions),
    measuredAt: new Date().toISOString()
  };

  if (!response.ok) {
    throw createDetailedError(`${resolveProviderDisplayName(promptOptions)} request failed (${response.status}).`, {
      requestSummary,
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw createDetailedError(
      `${resolveProviderDisplayName(promptOptions)} response JSON parse failed.`,
      {
        requestSummary,
        rawTextPreview: truncateText(rawText, 4000)
      },
      error
    );
  }

  const outputText = extractModelOutputText(parsed);

  if (!outputText.trim()) {
    throw createDetailedError("Model returned an empty response.", {
      requestSummary,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  return {
    requestBody: requestSummary,
    rawResponse: parsed,
    outputText
  };
}

async function requestCropRetryTranslation(server, options, targets = []) {
  const retryTargets = Array.isArray(targets) ? targets.filter((target) => Number.isFinite(Number(target?.id))) : [];
  if (retryTargets.length === 0) {
    return {
      requestBody: { cropRetryTargets: [] },
      rawResponse: { skipped: true, reason: "no-crop-retry-targets" },
      outputText: ""
    };
  }

  const preparedVariants = await prepareCropRetryImageVariants(options, retryTargets);
  const imageVariants = preparedVariants.imageVariants;
  if (imageVariants.length <= 1) {
    return {
      requestBody: { cropRetryTargets: retryTargets, imageVariants: summarizeImageVariants(imageVariants), skipped: true },
      rawResponse: { skipped: true, reason: "no-crop-retry-images" },
      outputText: ""
    };
  }

  const promptText = options.promptOverrideText || buildCropRetryPrompt(retryTargets);
  const promptOptions = {
    ...options,
    promptOverrideText: promptText,
    ocrBboxHints: []
  };
  const systemPrompt = buildSystemPrompt(promptOptions);
  const requestBody = isOpenAICodexProvider(promptOptions)
    ? buildResponsesRequestBody(promptOptions, imageVariants, promptText, systemPrompt)
    : buildChatRequestBody(promptOptions, buildMessages(promptOptions, imageVariants));
  const requestSummary = buildRequestSummary(server, promptOptions, imageVariants, promptText, systemPrompt);
  requestSummary.promptText = promptText;
  requestSummary.cropRetryTargets = retryTargets.map((target) => ({
    id: target.id,
    type: target.type,
    bbox: target.bbox,
    cropBox: target.cropBox,
    confidence: target.confidence ?? null
  }));

  if (isOpenAICodexProvider(promptOptions)) {
    emitRuntimeProgress(promptOptions, "model_requesting", "낮은 신뢰도 crop 재번역 중", `${retryTargets.length}개 항목`);
    const finalResult = await requestCodexResponsesText(server, promptOptions, requestBody, requestSummary);
    return {
      requestBody: requestSummary,
      rawResponse: finalResult.rawResponse,
      outputText: finalResult.outputText
    };
  }

  let response;
  try {
    emitRuntimeProgress(promptOptions, "model_requesting", "낮은 신뢰도 crop 재번역 중", `${retryTargets.length}개 항목`);
    response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(promptOptions),
      body: JSON.stringify(requestBody),
      signal: promptOptions.abortSignal
    });
  } catch (error) {
    throw createDetailedError(`${resolveProviderDisplayName(promptOptions)} crop retry request transport failed.`, { requestSummary }, error);
  }

  const rawText = await readResponseText(response, requestSummary, promptOptions);
  if (!response.ok) {
    throw createDetailedError(`${resolveProviderDisplayName(promptOptions)} crop retry request failed (${response.status}).`, {
      requestSummary,
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw createDetailedError(
      `${resolveProviderDisplayName(promptOptions)} crop retry response JSON parse failed.`,
      {
        requestSummary,
        rawTextPreview: truncateText(rawText, 4000)
      },
      error
    );
  }

  const outputText = extractModelOutputText(parsed);
  return {
    requestBody: requestSummary,
    rawResponse: parsed,
    outputText
  };
}

async function requestCodexResponsesText(server, options, requestBody, requestSummary) {
  let response;
  try {
    response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: options.abortSignal
    });
  } catch (error) {
    throw createDetailedError(`${resolveProviderDisplayName(options)} request transport failed.`, { requestSummary }, error);
  }

  if (!response.ok) {
    const rawText = await readResponseText(response, requestSummary, options);
    throw createDetailedError(`${resolveProviderDisplayName(options)} request failed (${response.status}).`, {
      requestSummary,
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  const streamResult = await readCodexResponsesStream(response, requestSummary, options);
  if (!streamResult.outputText.trim()) {
    throw createDetailedError("Model returned an empty response.", {
      requestSummary,
      rawResponse: streamResult.rawResponse
    });
  }

  return streamResult;
}

async function readResponseText(response, requestSummary, options) {
  try {
    return await response.text();
  } catch (error) {
    throw createDetailedError(
      `Failed to read ${resolveProviderDisplayName(options)} response body.`,
      {
        requestSummary,
        status: response.status,
        statusText: response.statusText
      },
      error
    );
  }
}

async function readCodexResponsesStream(response, requestSummary, options) {
  const rawText = await readResponseText(response, requestSummary, options);
  const parsed = parseResponsesSseText(rawText);
  const outputText = parsed.outputText.trim();
  if (!outputText) {
    throw createDetailedError("Model returned an empty response.", {
      requestSummary,
      rawTextPreview: truncateText(rawText, 4000),
      rawResponse: parsed.rawResponse
    });
  }

  return {
    outputText,
    rawResponse: {
      ...parsed.rawResponse,
      output_text: outputText,
      streamEventCount: parsed.eventCount
    }
  };
}

function parseResponsesSseText(rawText) {
  const deltas = [];
  let rawResponse = null;
  let eventCount = 0;

  for (const block of rawText.split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    eventCount += 1;

    if (parsed?.type === "response.output_text.delta" && typeof parsed.delta === "string") {
      deltas.push(parsed.delta);
      continue;
    }

    if ((parsed?.type === "response.completed" || parsed?.type === "response.incomplete") && parsed.response) {
      rawResponse = parsed.response;
      continue;
    }

    const nestedOutput = extractModelOutputText(parsed);
    if (nestedOutput) {
      deltas.push(nestedOutput);
    }
  }

  return {
    outputText: deltas.join(""),
    rawResponse,
    eventCount
  };
}

function extractModelOutputText(parsed) {
  if (typeof parsed?.output_text === "string") {
    return parsed.output_text.trim();
  }

  const chatContent = parsed?.choices?.[0]?.message?.content;
  if (typeof chatContent === "string") {
    return chatContent.trim();
  }
  if (Array.isArray(chatContent)) {
    return chatContent.map((item) => item?.text || "").join("\n").trim();
  }

  if (!Array.isArray(parsed?.output)) {
    return "";
  }

  const parts = [];
  for (const item of parsed.output) {
    if (typeof item?.content === "string") {
      parts.push(item.content);
      continue;
    }
    if (!Array.isArray(item?.content)) {
      continue;
    }
    for (const content of item.content) {
      if (typeof content?.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

async function testModelReply(server, options) {
  if (isOpenAICodexProvider(options)) {
    return testCodexResponsesReply(server, options);
  }

  const messages = [
    {
      role: "system",
      content: [{ type: "text", text: "Reply in one short sentence." }]
    },
    {
      role: "user",
      content: [{ type: "text", text: "Say 'model test ok'." }]
    }
  ];
  const requestBody = buildChatRequestBody(options, messages, 48);

  let response;
  try {
    response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw createDetailedError("모델 테스트 요청을 보내지 못했습니다.", {
      requestBody: {
        ...requestBody,
        messages: requestBody.messages
      }
    }, error);
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw createDetailedError(`모델 테스트 응답이 실패했습니다 (${response.status}).`, {
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw createDetailedError("모델 테스트 응답을 JSON으로 읽지 못했습니다.", {
      rawTextPreview: truncateText(rawText, 4000)
    }, error);
  }

  const content = parsed?.choices?.[0]?.message?.content;
  const outputText = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content.map((item) => item?.text || "").join("\n").trim()
      : "";

  if (!outputText) {
    throw createDetailedError("모델 테스트 응답이 비어 있습니다.", {
      rawResponse: parsed
    });
  }

  return {
    outputText,
    launchTarget: inspectModelLaunch(options)
  };
}

async function testCodexResponsesReply(server, options) {
  const requestBody = {
    model: resolveRequestModelName(options),
    instructions: "Reply in one short sentence.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say 'model test ok'." }]
      }
    ],
    reasoning: {
      effort: resolveConfiguredCodexReasoningEffort(options)
    },
    stream: true,
    store: false
  };

  let response;
  try {
    response = await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw createDetailedError("모델 테스트 요청을 보내지 못했습니다.", {
      requestBody
    }, error);
  }

  if (!response.ok) {
    const rawText = await readResponseText(response, {}, options);
    throw createDetailedError(`모델 테스트 응답이 실패했습니다 (${response.status}).`, {
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText, 4000)
    });
  }

  const result = await readCodexResponsesStream(response, {}, options);

  return {
    outputText: result.outputText,
    launchTarget: inspectModelLaunch(options)
  };
}

async function saveArtifacts(options, result) {
  await mkdir(options.outputDir, { recursive: true });
  const systemPrompt = buildSystemPrompt(options);
  const imageVariants = result.requestBody?.imageVariants || [];
  const prompt = result.requestBody?.promptText || options.promptOverrideText || getOverlayPrompt(options, imageVariants);
  const payload = {
    label: options.label,
    imagePath: options.imagePath,
    createdAt: new Date().toISOString(),
    settings: {
      port: options.port,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      maxTokens: options.maxTokens,
      ctx: options.ctx,
      batch: options.batch,
      ubatch: options.ubatch,
      gemmaVramMode: options.gemmaVramMode,
      cacheTypeK: options.cacheTypeK,
      cacheTypeV: options.cacheTypeV,
      ctxCheckpoints: options.ctxCheckpoints,
      kvOffload: options.kvOffload,
      mmprojOffload: options.mmprojOffload,
      threads: options.threads,
      threadsBatch: options.threadsBatch,
      poll: options.poll,
      pollBatch: options.pollBatch,
      prioBatch: options.prioBatch,
      cacheIdleSlots: options.cacheIdleSlots,
      cacheReuse: options.cacheReuse,
      enableMetrics: options.enableMetrics,
      enablePerf: options.enablePerf,
      modelProvider: resolveModelProvider(options),
      modelSource: resolveConfiguredModelSource(options),
      modelRepo: resolveConfiguredModelRepo(options),
      modelFile: resolveConfiguredModelFile(options),
      mmprojRepo: resolveConfiguredMmprojRepo(options),
      mmprojFile: resolveConfiguredMmprojFile(options),
      mmprojUrl: resolveConfiguredMmprojUrl(options),
      localModelPath: resolveConfiguredLocalModelPath(options),
      localMmprojPath: resolveConfiguredLocalMmprojPath(options),
      codexModel: resolveConfiguredCodexModel(options),
      codexReasoningEffort: resolveConfiguredCodexReasoningEffort(options),
      codexOauthPort: options.codexOauthPort,
      fitTargetMb: options.fitTargetMb,
      imageMinTokens: options.imageMinTokens,
      imageMaxTokens: options.imageMaxTokens,
      includeEnhancedVariant: options.includeEnhancedVariant,
      enhancedMaxLongSide: options.enhancedMaxLongSide,
      enhancedContrast: options.enhancedContrast,
      hfHomeDir: resolveHfHomeDir(options),
      hfHubCacheDir: resolveHubCacheDir(options)
    },
    requestSummary: result.requestBody,
    systemPrompt,
    prompt,
    outputText: result.outputText,
    rawResponse: result.rawResponse
  };

  await writeFile(path.join(options.outputDir, "result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(path.join(options.outputDir, "result.md"), `${result.outputText.trim()}\n`, "utf8");
}

module.exports = {
  buildMessages,
  buildLaunchArgs,
  buildOcrRuntimeEnv,
  buildPaddleOcrImportCheckScript,
  buildResponsesRequestBody,
  collectRequiredHfDownloads,
  collectRequiredPaddleOcrModelDownloads,
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  convertImageToPngBufferWithFfmpeg,
  enhanceBitmapBuffer,
  extractModelOutputText,
  getOverlayPrompt,
  getScaledSize,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  parsePipRawProgress,
  resolvePaddleOcrImportCheckTimeoutMs,
  resolveOcrBboxTimeoutMs,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrPipInstallBatches,
  resolveOcrInstallBatchProgressRanges,
  resolveFfmpegPath,
  resolveLlamaCppCacheDir,
  buildLlamaServerEnv,
  resolveManagedHfFilePath,
  inspectModelLaunch,
  isModelCached,
  parseResponsesSseText,
  prepareImageVariants,
  requestTranslation,
  requestCropRetryTranslation,
  saveArtifacts,
  startServer,
  stopServer,
  testModelReply
};
