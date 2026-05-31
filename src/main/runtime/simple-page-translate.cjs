const { spawn } = require("node:child_process");
const { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const { resolveBundledServerPath } = require("./resolve-llama-runtime.cjs");

const DEFAULT_MODEL_HF = "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
const DEFAULT_HF_FILE = "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf";
const DEFAULT_MMPROJ_HF = "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
const DEFAULT_MMPROJ_FILE = "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_REASONING_EFFORT = "low";
const DEFAULT_API_KEY = "local-llama-server";
const DEFAULT_OCR_CPU_PIP_PACKAGES = ["paddlepaddle==3.3.1", "paddleocr==3.5.0", "paddlex[ocr]==3.5.2"];
const DEFAULT_OCR_GPU_PADDLE_PACKAGE = "paddlepaddle-gpu==3.3.1";
const DEFAULT_OCR_GPU_EXTRA_PACKAGES = ["paddleocr==3.5.0", "paddlex[ocr]==3.5.2"];
const DEFAULT_OCR_GPU_CUDA_TAG = "cu126";
const OCR_INSTALL_MARKER_FILE = "install-complete.json";
const MAX_LOG_PREVIEW_LENGTH = 8000;
const MM_PROJ_CANDIDATE_NAMES = ["mmproj-BF16.gguf", "mmproj-F16.gguf", "mmproj-F32.gguf", "mmproj.gguf"];
const CROP_RETRY_MIN_SIDE_PX = 192;
const CROP_RETRY_MIN_MARGIN_PX = 64;
const CROP_RETRY_MARGIN_RATIO = 0.5;

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

function getScaledSize(width, height, maxLongSide) {
  const longSide = Math.max(width, height);
  if (longSide <= 0 || longSide <= maxLongSide) {
    return { width, height };
  }

  const scale = maxLongSide / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function enhanceBitmapBuffer(bitmap, contrast = 1, grayscale = false) {
  const output = Buffer.from(bitmap);
  const translation = ((1 - contrast) / 2) * 255;

  for (let offset = 0; offset < output.length; offset += 4) {
    const blue = output[offset];
    const green = output[offset + 1];
    const red = output[offset + 2];

    if (grayscale) {
      const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
      const adjusted = clampByte(luminance * contrast + translation);
      output[offset] = adjusted;
      output[offset + 1] = adjusted;
      output[offset + 2] = adjusted;
      continue;
    }

    output[offset] = clampByte(blue * contrast + translation);
    output[offset + 1] = clampByte(green * contrast + translation);
    output[offset + 2] = clampByte(red * contrast + translation);
  }

  return output;
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
    process.env.MANGA_TRANSLATOR_TOOLS_DIR,
    path.resolve(__dirname, "..", "tools"),
    path.resolve(__dirname, "..", "..", "tools")
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function defaultServerPath(options = {}) {
  return resolveBundledServerPath(resolveToolsDir(options));
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
    process.env.MANGA_TRANSLATOR_FFMPEG_PATH
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
  return options.hfHomeDir || process.env.HF_HOME || process.env.MANGA_TRANSLATOR_HF_HOME || defaultHfHomeDir();
}

function resolveHubCacheDir(options = {}) {
  const hfHomeDir = resolveHfHomeDir(options);
  return options.hfHubCacheDir || process.env.HF_HUB_CACHE || process.env.HUGGINGFACE_HUB_CACHE || (hfHomeDir ? path.join(hfHomeDir, "hub") : null);
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
  const explicit = String(options.llamaCacheDir ?? process.env.MANGA_TRANSLATOR_LLAMA_CACHE_DIR ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (process.platform === "win32") {
    const localAppData = String(process.env.LOCALAPPDATA ?? "").trim();
    return localAppData ? path.join(localAppData, "llama.cpp") : null;
  }
  const xdgCacheHome = String(process.env.XDG_CACHE_HOME ?? "").trim();
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "llama.cpp");
  }
  const homeDir = String(process.env.HOME ?? "").trim();
  return homeDir ? path.join(homeDir, ".cache", "llama.cpp") : null;
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

function isUsableFile(filePath) {
  try {
    return Boolean(filePath) && statSync(filePath).isFile() && statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

async function probeContentLength(url, signal) {
  try {
    const response = await fetch(url, { method: "HEAD", signal });
    if (!response.ok) {
      return 0;
    }
    return readContentLength(response);
  } catch {
    return 0;
  }
}

async function downloadHfFileWithProgress(task, options = {}, progress = {}) {
  const partPath = `${task.destination}.part`;
  await mkdir(path.dirname(task.destination), { recursive: true });
  await rm(partPath, { force: true });

  emitRuntimeProgress(options, "model_downloading", "Gemma 모델 다운로드 중", `${task.label}: ${task.file}`, {
    progressMode: progress.knownAggregateBytes || progress.totalBytes ? "determinate" : "log-only",
    progressPercent: progress.knownAggregateBytes ? progress.completedBytes / progress.knownAggregateBytes : progress.totalBytes ? 0 : undefined,
    progressBytes: progress.knownAggregateBytes ? progress.completedBytes : progress.totalBytes ? 0 : undefined,
    progressTotalBytes: progress.knownAggregateBytes || progress.totalBytes || undefined,
    installLogLine: `${task.label} 다운로드 시작: ${task.file}`
  });

  const response = await fetch(task.url, { signal: options.abortSignal });
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
  const writer = createWriteStream(partPath, { flags: "wx" });
  let receivedBytes = 0;
  let lastEmitAt = 0;
  const startedAt = Date.now();

  try {
    while (true) {
      if (options.abortSignal?.aborted) {
        throw createAbortError();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
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
    writer.destroy();
    await rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
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
  emitRuntimeProgress(options, "model_downloading", state.completed ? "Gemma 모델 다운로드 완료" : "Gemma 모델 다운로드 중", `${task.label}: ${task.file}`, {
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

function resolveConfiguredModelSource(options = {}) {
  return String(options.modelSource ?? "").trim() === "local" ? "local" : "huggingface";
}

function resolveModelProvider(options = {}) {
  return String(options.modelProvider ?? "").trim() === "openai-codex" ? "openai-codex" : "gemma";
}

function isOpenAICodexProvider(options = {}) {
  return resolveModelProvider(options) === "openai-codex";
}

function resolveProviderDisplayName(options = {}) {
  return isOpenAICodexProvider(options) ? "OpenAI Codex" : "Gemma";
}

function resolveConfiguredCodexModel(options = {}) {
  return String(options.codexModel ?? process.env.MANGA_TRANSLATOR_CODEX_MODEL ?? "").trim() || DEFAULT_CODEX_MODEL;
}

function resolveConfiguredCodexReasoningEffort(options = {}) {
  const value = String(process.env.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT ?? options.codexReasoningEffort ?? "").trim();
  if (value === "minimal") {
    return "low";
  }
  return ["none", "low", "medium", "high", "xhigh"].includes(value) ? value : DEFAULT_CODEX_REASONING_EFFORT;
}

function resolveConfiguredLocalModelPath(options = {}) {
  const value = String(options.localModelPath ?? "").trim();
  return value ? path.resolve(value) : null;
}

function resolveConfiguredLocalMmprojPath(options = {}) {
  const value = String(options.localMmprojPath ?? "").trim();
  return value ? path.resolve(value) : null;
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

const OVERLAY_OUTPUT_SCHEMA = [
  "id: 1",
  "type: solid",
  "x1: 120",
  "y1: 80",
  "x2: 280",
  "y2: 320",
  "direction: horizontal",
  "angle: 0",
  "fontSize: 28",
  "confidence: 0.86",
  "jp: 馬鹿者… 無理をするな",
  "ko: 바보 같은 녀석… 무리하지 마라."
].join("\n");

const OVERLAY_PROMPT_SECTIONS = [
  [
    "Task",
    "You are given the same Japanese manga page in multiple full-page renderings.",
    "Image 1 is the coordinate-authority full page. Assist images are only for reading the same page.",
    "Detect every visible Japanese text group and translate it into concise Korean.",
    "Scan the entire page before writing records; do not stop after the first obvious text.",
    "First identify the exact Japanese glyph strokes for each item, then write the record. Do not estimate from the speech bubble or panel shape.",
    "Before reading dialogue text, segment the visible speech balloons themselves. Each distinct balloon lobe and each separated dialogue text cluster becomes a separate dialogue record.",
    "Only output real Japanese text. Do not output decorative line art, background marks, panel ornaments, texture, or unreadable marks as text."
  ],
  [
    "Output",
    "Return plain text records only. Do not output JSON, markdown, bullets, commentary, or code fences.",
    "Use exactly these keys, one per line: id, type, x1, y1, x2, y2, direction, angle, fontSize, confidence, jp, ko.",
    "Do not blindly copy the example values. Estimate fontSize and direction from the actual glyphs in Image 1.",
    "confidence is your confidence from 0.00 to 1.00 that the item is real Japanese text, correctly read, correctly typed, and correctly translated.",
    "Use confidence below 0.72 when the crop is hard to read, partly clipped, possibly decorative, or the translation may be uncertain.",
    "If jp has multiple visible source lines, put every readable source line in jp. Continuation lines after jp: belong to jp until the ko: key.",
    "Write ko as natural Korean for horizontal reading. Do not mirror Japanese vertical line breaks; use commas or short Korean phrases unless a real list or dialogue pause needs a line break.",
    "If the entire jp or ko would be only [?], skip that record instead of outputting an unreadable placeholder.",
    "Put one blank line between records.",
    "Example:",
    OVERLAY_OUTPUT_SCHEMA
  ],
  [
    "Geometry",
    "Coordinates are integers in the coordinate frame described above, with top-left origin.",
    "x1, y1, x2, y2 describe the tight rectangle corners of the visible Japanese glyph ink and its outline.",
    "For each item, first find the four extremes of the complete jp text: leftmost visible glyph/outline pixel, topmost pixel, rightmost pixel, and bottommost pixel. Then output x1 = left, y1 = top, x2 = right, y2 = bottom.",
    "The rectangle must cover every visible stroke, outline, dakuten mark, punctuation mark, small kana, long vowel mark, and trailing kana belonging to jp.",
    "A tight rectangle may still have a tiny 1-3 px safety margin around glyph ink; missing any stroke outside the box is worse than including a hair of surrounding paper.",
    "For vertical Japanese text, the rectangle should cover the union of all vertical glyph columns, from the rightmost visible stroke to the leftmost visible stroke and from the topmost glyph to the bottommost punctuation.",
    "For multi-column vertical text, do not box only the first column, center column, or top half. The bbox is invalid if any character from jp would remain outside x1..x2 or y1..y2.",
    "For one or two vertical text columns, keep w close to the actual glyph-column width, but never make it narrower than the full visible strokes.",
    "Never include the whole speech bubble, caption plate, panel, background art, motion lines, or blank margin.",
    "Never enlarge, shift, or reshape the rectangle to make Korean easier to fit.",
    "fontSize is the apparent Japanese glyph size in Image 1 pixels.",
    "fontSize is the height of one normal full-size source character, not the Korean overlay size and not the example default.",
    "For mixed handwriting, use the main readable glyph size; do not reduce fontSize because small furigana, punctuation, or thin strokes are present.",
    "direction is the original Japanese glyph writing direction: horizontal or vertical. This is about the Japanese source text, not the Korean rendering.",
    "angle is the visible glyph slant in degrees from -30 to 30. Use 0 for upright text.",
    "Before final output, mentally fill each bbox with translucent color: no Japanese glyph from jp should remain visible outside that filled area.",
    "Then check tightness: if the filled area covers large blank bubble paper or caption-box padding on any side, redraw the bbox tighter around the glyph ink.",
    "Then check placement: the center of the bbox must lie on or very near the jp glyph ink cluster, not on adjacent background art or empty panel space.",
    "Decorative hearts, bubble tails, panel borders, box borders, background textures, and motion effects are not Japanese glyph ink."
  ],
  [
    "Segmentation",
    "Each speech bubble is one dialogue item. Adjacent or touching speech bubbles must stay separate.",
    "If two white balloon lobes touch, overlap, stack vertically, or connect through a narrow neck, still treat them as separate dialogue items.",
    "If one visible outline contains upper and lower lobes with a narrow waist, large blank gap, or two separate text clusters, split it into one record per lobe/text cluster.",
    "Do not create one tall dialogue bbox spanning stacked upper/lower bubbles.",
    "Do not merge two speech bubbles just because the sentence continues across them; split jp and ko by the visible balloon/lobe that contains each text group.",
    "Inside one speech bubble, group all Japanese glyph lines from that same bubble into one item.",
    "Process panels and bubbles exhaustively from top to bottom and right to left.",
    "For captions and narration boxes, box only the printed glyphs, not the surrounding box.",
    "For SFX, box only the sound-effect glyph strokes and their visible outline, not speed lines or impact effects.",
    "For long horizontal SFX, include the entire sound from first glyph through final kana, including stretched lines, detached outline tips, and the last small/isolated character.",
    "For outlined SFX, the bbox follows the outermost visible contour of the outline, not only the dark center stroke.",
    "SFX is often gray, slanted, outlined, partly behind characters, or outside OCR candidates. Do a separate SFX pass after dialogue/captions and add every clear kana sound effect.",
    "Do not invent SFX from vertical panel trim, furniture lines, wall patterns, or isolated non-character strokes.",
    "Include meaningful short interjections, names, captions, and SFX."
  ],
  [
    "Rendering hints",
    "type is one of solid or nonsolid.",
    "Use type solid only when the Japanese glyphs sit on a plain, flat, single-color speech-bubble or caption background where an opaque Korean text box is appropriate.",
    "Use type nonsolid when the Japanese glyphs sit on artwork, screentone, gradient, texture, transparent or gray bubble fill, SFX lettering, labels, handwriting, or any uncertain/mixed background.",
    "If unsure whether the background is truly flat and single-color, choose nonsolid.",
    "For sound-effect or reaction lettering, ko must be bare Korean effect lettering only: no parentheses, brackets, quotes, stage directions, action descriptions, or explanatory notes.",
    "For sound-effect or reaction lettering, translate the visual sound/reaction text itself, not the character's motion or the scene description.",
    "Use angle 0 for ordinary upright speech and captions; use a nonzero angle only when the source glyphs are visibly slanted.",
    "Keep Korean short enough for an on-image overlay while preserving meaning.",
    "For handwritten diagrams and search-word lists, translate the whole note as one compact Korean phrase or comma-separated list when possible.",
    "If OCR is uncertain, write [?] only for the uncertain fragment and still output the item."
  ]
];

const PROMPT_KO_BBOX_LINES_MULTIVIEW = buildOverlayPrompt();

function buildSystemPrompt(options = {}) {
  const lines = [
    "You are an OCR and manga-translation engine.",
    "Return only the machine-readable record format requested by the user prompt.",
    "Geometry accuracy comes before Korean text fit: preserve the original Japanese glyph position and apparent size.",
    "Never merge separate speech bubbles, including touching or stacked balloon lobes.",
    "For SFX records, output bare Korean effect lettering only; do not wrap it in parentheses/brackets/quotes or turn it into a stage direction."
  ];

  if (options.regionCropMode) {
    lines.push(
      "Selected-region mode: group by visual text container, not by line or column. One speech bubble or one caption plate is one item even when the Japanese is split across multiple vertical columns or lines."
    );
  }

  return lines.join("\n\n");
}

function buildOverlayPrompt(options = {}, imageVariants = []) {
  const sections = OVERLAY_PROMPT_SECTIONS.map(([title, ...lines]) => [title, ...lines]);
  sections[0] = buildTaskSection(options, imageVariants);
  const regionCropSection = buildRegionCropSection(options);
  if (regionCropSection.length > 1) {
    sections.splice(1, 0, regionCropSection);
  }
  const coordinateSection = buildCoordinateCalibrationSection(options, imageVariants);
  if (coordinateSection.length > 1) {
    sections.splice(2, 0, coordinateSection);
  }
  const ocrHintSection = buildOcrBboxHintSection(options, imageVariants);
  if (ocrHintSection.length > 1) {
    const coordinateIndex = sections.findIndex((section) => section[0] === "Coordinate calibration");
    sections.splice(coordinateIndex === -1 ? 2 : coordinateIndex + 1, 0, ocrHintSection);
  }

  return sections
    .map(([title, ...lines]) => [`# ${title}`, ...lines].join("\n"))
    .join("\n\n");
}

function getOverlayPrompt(options = {}, imageVariants = []) {
  return buildOverlayPrompt(options, imageVariants);
}

function buildTaskSection(options = {}, imageVariants = []) {
  const hasAssistImages = imageVariants.length > 1;
  const regionCropMode = Boolean(options.regionCropMode);
  return [
    "Task",
    hasAssistImages
      ? "You are given the same Japanese manga page in multiple full-page renderings."
      : regionCropMode
        ? "You are given one user-selected crop from a Japanese manga page."
        : "You are given one full-page Japanese manga image.",
    hasAssistImages
      ? "Image 1 is the coordinate-authority full page. Assist images are only for reading the same page."
      : regionCropMode
        ? "Image 1 is the coordinate-authority selected crop."
        : "Image 1 is the coordinate-authority full page.",
    "Detect every visible Japanese text group and translate it into concise Korean.",
    "Scan the entire page before writing records; do not stop after the first obvious text.",
    "First identify the exact Japanese glyph strokes for each item, then write the record. Do not estimate from the speech bubble or panel shape.",
    "Before reading dialogue text, segment the visible speech balloons themselves. Each distinct balloon lobe and each separated dialogue text cluster becomes a separate dialogue record.",
    "Only output real Japanese text. Do not output decorative line art, background marks, panel ornaments, texture, or unreadable marks as text."
  ];
}

function buildRegionCropSection(options = {}) {
  if (!options.regionCropMode) {
    return [];
  }

  return [
    "Selected region grouping",
    "This image is a crop selected by the user, so there may be one speech bubble, part of one bubble, multiple bubbles, captions, or SFX inside it.",
    "Do not treat the whole crop as one text item. Create multiple records only for multiple visually separate containers: separate speech bubbles/lobes, separate caption plates, or separate SFX glyph groups.",
    "If the crop contains one speech bubble or one caption plate, output exactly one record for all readable Japanese in that container.",
    "Inside one speech bubble, never split by Japanese vertical column, text line, word, sentence fragment, punctuation gap, or line break.",
    "For vertical dialogue in one bubble, jp must include all columns in natural Japanese reading order, and ko must be one coherent Korean translation for that bubble.",
    "Only split a dialogue item when there is a visible separate speech bubble/lobe or clearly separate dialogue container, not merely because columns are separated by blank paper.",
    "The bbox for that one record should tightly cover the union of all visible Japanese glyph ink belonging to the same bubble/caption, not the whole bubble paper."
  ];
}

function buildCoordinateCalibrationSection(options = {}, imageVariants = []) {
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const geometryVariant = imageVariants.find((variant) => variant.role === "openai-vision") || imageVariants[0];
  const sentWidth = readPositiveInteger(geometryVariant?.width);
  const sentHeight = readPositiveInteger(geometryVariant?.height);
  const coordinateFrame = resolvePromptCoordinateFrame(options, imageVariants);
  if (!originalWidth || !originalHeight) {
    return [];
  }

  const lines = ["Coordinate calibration", `The original page is ${originalWidth}x${originalHeight} px.`];

  if (coordinateFrame.space === "pixels") {
    lines.push(
      `Image 1 was prepared before the API call to match the OpenAI detail: original vision frame, so the model sees Image 1 as ${coordinateFrame.frame.width}x${coordinateFrame.frame.height} px.`,
      `Return x1, y1, x2, y2 as integer pixel coordinates in that ${coordinateFrame.frame.width}x${coordinateFrame.frame.height} Image 1 frame.`,
      "Do not return width/height, original-page pixels, normalized 0..1000 coordinates, viewport coordinates, crop coordinates, tile coordinates, or model-internal coordinates.",
      `Use the full visible Image 1 frame as the coordinate frame: left edge 0, top edge 0, right edge ${coordinateFrame.frame.width}, bottom edge ${coordinateFrame.frame.height}.`,
      "The app will map these sent-image pixels back to the original page after the model response."
    );
    return lines;
  }

  lines.push(
    "Return x1, y1, x2, y2 as normalized 0..1000 corner coordinates over Image 1, not viewport, crop, tile, or model-internal coordinates.",
    "Use the full visible Image 1 frame as the coordinate frame: left edge 0, top edge 0, right edge 1000, bottom edge 1000.",
    "Because Image 1 preserves the original aspect ratio, these normalized coordinates map directly back to the original page."
  );

  if (sentWidth && sentHeight && (sentWidth !== originalWidth || sentHeight !== originalHeight)) {
    lines.push(
      `For OpenAI vision, Image 1 was pre-scaled to ${sentWidth}x${sentHeight} px for detail: original before sending so the coordinate frame matches what the model sees.`,
      `If measuring in sent pixels, convert directly with x1 = round(left * 1000 / ${sentWidth}), y1 = round(top * 1000 / ${sentHeight}), x2 = round(right * 1000 / ${sentWidth}), y2 = round(bottom * 1000 / ${sentHeight}).`
    );
  }

  return lines;
}

function buildOcrBboxHintSection(options = {}, imageVariants = []) {
  const hints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  if (hints.length === 0) {
    return [];
  }

  const frame = resolvePromptCoordinateFrame(options, imageVariants);
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const formattedHints = hints
    .slice(0, 80)
    .map((hint, index) => formatOcrBboxHintForPrompt(hint, index + 1, frame, originalWidth, originalHeight))
    .filter(Boolean);
  const candidateIds = hints
    .slice(0, formattedHints.length)
    .map((hint, index) => readPositiveInteger(hint.id) || index + 1);
  const maxCandidateId = Math.max(...candidateIds, 0);

  if (formattedHints.length === 0) {
    return [];
  }

  return [
    "OCR bbox candidates",
    "An external OCR geometry detector has already proposed bbox candidates. Some candidates include low-trust OCR text hints for slot matching only.",
    "OCR text hints may be wrong, incomplete, or split strangely. Use Image 1 as the authority for the actual Japanese text and Korean translation.",
    "Use the OCR text hint to keep each translated record attached to the correct candidate id, especially when solid-background and nonsolid-background candidates are close together.",
    "Treat each candidate as a locked geometry slot. For every candidate that contains Japanese glyphs, output one record with that same id and the exact x1, y1, x2, y2 numbers shown below.",
    `Required candidate ids: ${candidateIds.join(", ")}.`,
    "Read and translate only the text inside that candidate rectangle plus a tiny visual margin; do not move the rectangle to a different nearby text group.",
    "For each candidate, read every visible Japanese line inside the rectangle. A candidate record is incomplete if jp or ko contains only the first line while lower or side lines remain readable.",
    "If a candidate is a handwritten note or diagram label, preserve all readable words, but translate ko compactly for horizontal Korean reading rather than copying the Japanese vertical line breaks.",
    "For ocr_textline and ocr_textgroup candidates, use type nonsolid unless the text is clearly on a flat single-color bubble or caption background.",
    "Labels, handwriting, captions on texture, diagram text, search terms, and sound-effect lettering are nonsolid.",
    "You may change a candidate bbox only when Image 1 clearly proves the candidate clips visible glyph strokes or includes non-text art; then change the minimum amount needed.",
    "Do not merge two candidates into one record, even when the sentence continues across them. Candidate rectangles are separate output records.",
    "If two candidates are stacked or touching speech bubbles, output two separate dialogue records with their original ids.",
    "OCR candidates are a floor, not a ceiling. After processing candidates, inspect the whole Image 1 again for missing Japanese text.",
    `If the detector missed visible Japanese text, add a new record with id greater than ${maxCandidateId}. Never reuse a candidate id for missing text outside that candidate rectangle.`,
    "New records are allowed only for clear Japanese glyphs that are not covered by any candidate.",
    "For new missing SFX records, search especially near character bodies, panel edges, and lower panels where OCR often misses gray or outlined kana. The bbox must visibly cover kana/SFX glyph strokes.",
    "Never add SFX on panel trim, furniture lines, wall patterns, or isolated vertical strokes.",
    "The candidate coordinates below are already converted into the same coordinate frame required for your output.",
    "",
    ...formattedHints
  ];
}

function formatOcrBboxHintForPrompt(hint, fallbackId, frame, originalWidth, originalHeight) {
  const x1 = Number(hint?.x1);
  const y1 = Number(hint?.y1);
  const x2 = Number(hint?.x2);
  const y2 = Number(hint?.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return "";
  }

  const id = readPositiveInteger(hint.id) || fallbackId;
  const label = sanitizeHintLabel(hint.label);
  const converted = convertOriginalPixelBoxToPromptFrame({ x1, y1, x2, y2 }, frame, originalWidth, originalHeight);
  const score = Number.isFinite(hint.score) ? ` score:${Math.round(hint.score * 100) / 100}` : "";
  const ocrText = sanitizeOcrTextForPrompt(readOcrCandidateText(hint));
  const textHint = ocrText ? ` ocrText:${JSON.stringify(ocrText)}` : "";
  return `candidate ${id}: label:${label} x1:${converted.x1} y1:${converted.y1} x2:${converted.x2} y2:${converted.y2}${score}${textHint}`;
}

function convertOriginalPixelBoxToPromptFrame(box, frame, originalWidth, originalHeight) {
  if (frame.space === "pixels" && originalWidth && originalHeight) {
    const xScale = frame.frame.width / originalWidth;
    const yScale = frame.frame.height / originalHeight;
    return {
      x1: Math.round(Math.min(box.x1, box.x2) * xScale),
      y1: Math.round(Math.min(box.y1, box.y2) * yScale),
      x2: Math.round(Math.max(box.x1, box.x2) * xScale),
      y2: Math.round(Math.max(box.y1, box.y2) * yScale)
    };
  }

  if (originalWidth && originalHeight) {
    return {
      x1: Math.round((Math.min(box.x1, box.x2) / originalWidth) * 1000),
      y1: Math.round((Math.min(box.y1, box.y2) / originalHeight) * 1000),
      x2: Math.round((Math.max(box.x1, box.x2) / originalWidth) * 1000),
      y2: Math.round((Math.max(box.y1, box.y2) / originalHeight) * 1000)
    };
  }

  return {
    x1: Math.round(Math.min(box.x1, box.x2)),
    y1: Math.round(Math.min(box.y1, box.y2)),
    x2: Math.round(Math.max(box.x1, box.x2)),
    y2: Math.round(Math.max(box.y1, box.y2))
  };
}

function sanitizeHintLabel(value) {
  const text = String(value ?? "text").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return text || "text";
}

function readOcrCandidateText(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return "";
  }
  for (const key of ["ocrText", "ocr_text", "text", "content", "block_content", "rec_text", "transcription"]) {
    const text = normalizeOcrTextValue(candidate[key]);
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeOcrTextValue(value) {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeOcrTextValue).filter(Boolean).join(" ").trim();
  }
  if (value && typeof value === "object") {
    for (const key of ["text", "content", "value", "rec_text", "transcription"]) {
      const text = normalizeOcrTextValue(value[key]);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function sanitizeOcrTextForPrompt(value) {
  return truncateText(normalizeOcrTextValue(value).replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim(), 160);
}

function resolvePromptCoordinateFrame(options = {}, imageVariants = []) {
  if (isOpenAICodexProvider(options)) {
    const geometryVariant = imageVariants.find((variant) => variant.role === "openai-vision") || imageVariants[0];
    const width = readPositiveInteger(geometryVariant?.width) || readPositiveInteger(options.imageWidth) || 1000;
    const height = readPositiveInteger(geometryVariant?.height) || readPositiveInteger(options.imageHeight) || 1000;
    return {
      space: "pixels",
      frame: { width, height }
    };
  }

  return {
    space: "normalized_1000",
    frame: { width: 1000, height: 1000 }
  };
}

function readPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
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
        stdio: ["ignore", "pipe", "pipe"]
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

const OPENAI_ORIGINAL_DETAIL_PATCH_SIZE = 32;
const OPENAI_ORIGINAL_DETAIL_PATCH_BUDGET = 10000;
const OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION = 6000;

function calculateOpenAIOriginalDetailSize(width, height) {
  if (!width || !height) {
    return { width, height };
  }

  const patchCount = (imageWidth, imageHeight) =>
    Math.ceil(imageWidth / OPENAI_ORIGINAL_DETAIL_PATCH_SIZE) * Math.ceil(imageHeight / OPENAI_ORIGINAL_DETAIL_PATCH_SIZE);

  const maxDimensionScale = Math.min(
    1,
    OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION / width,
    OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION / height
  );
  const patchBudgetScale = Math.sqrt(
    (OPENAI_ORIGINAL_DETAIL_PATCH_BUDGET * OPENAI_ORIGINAL_DETAIL_PATCH_SIZE * OPENAI_ORIGINAL_DETAIL_PATCH_SIZE) /
      (width * height)
  );
  let scale = Math.min(maxDimensionScale, patchBudgetScale, 1);
  let targetWidth = Math.max(1, Math.floor(width * scale));
  let targetHeight = Math.max(1, Math.floor(height * scale));

  while (
    targetWidth > OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION ||
    targetHeight > OPENAI_ORIGINAL_DETAIL_MAX_DIMENSION ||
    patchCount(targetWidth, targetHeight) > OPENAI_ORIGINAL_DETAIL_PATCH_BUDGET
  ) {
    scale *= 0.999;
    targetWidth = Math.max(1, Math.floor(width * scale));
    targetHeight = Math.max(1, Math.floor(height * scale));
  }

  return {
    width: targetWidth,
    height: targetHeight
  };
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
      env: process.env
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
    const idText = Number.isFinite(Number(variant.itemId)) ? ` item id ${variant.itemId}` : " one low-confidence item";
    const box = variant.cropBox
      ? ` Crop on original page: x=${variant.cropBox.x}, y=${variant.cropBox.y}, w=${variant.cropBox.w}, h=${variant.cropBox.h}.`
      : "";
    return `Image ${index + 1}: expanded crop for${idText}. Use it only to re-read that same id; do not create new ids or change geometry.${sizeText}${originalSizeText}${box}`;
  }

  return `Image ${index + 1}: the original full manga page. Use it as the geometry authority.${sizeText}${originalSizeText}`;
}

function buildCropRetryPrompt(targets = []) {
  const targetLines = targets.map((target, index) => {
    const cropImageIndex = index + 2;
    const confidence = Number.isFinite(Number(target.confidence)) ? Number(target.confidence).toFixed(2) : "unknown";
    const bbox = target.bbox
      ? `bbox x=${target.bbox.x} y=${target.bbox.y} w=${target.bbox.w} h=${target.bbox.h}`
      : "bbox unchanged";
    return [
      `target ${target.id}: cropImage:${cropImageIndex}`,
      `type:${target.type || "nonsolid"} direction:${target.direction || "horizontal"} angle:${Number.isFinite(Number(target.angle)) ? target.angle : 0} fontSize:${Number.isFinite(Number(target.fontSize)) ? target.fontSize : ""} confidence:${confidence}`,
      bbox
    ].join(" ");
  });

  return [
    "# Task",
    "You are directly OCR-reading and translating only the low-confidence manga crop images listed below.",
    "Image 1 is the full page for context only. Each following image is an expanded crop for exactly one target id.",
    "Do not detect new text, do not output extra ids, and do not change any bbox geometry.",
    "For each target, ignore any previous model OCR/translation. The crop image itself is the authority.",
    "Read all real Japanese text inside that crop for the same target id, then translate it naturally into Korean.",
    "",
    "# Output",
    "Return plain text records only. Do not output JSON, markdown, bullets, commentary, or code fences.",
    "Output exactly one record for each target id, using exactly these keys: id, type, direction, angle, fontSize, confidence, jp, ko.",
    "Do not output x1, y1, x2, y2, bbox, width, or height.",
    "confidence is 0.00 to 1.00 for the corrected OCR+translation.",
    "If the crop is decoration, panel trim, texture, non-Japanese art, or otherwise not real Japanese text, output type: reject, confidence: 1, jp: [non-text], ko: [non-text].",
    "If the crop still has readable Japanese, never output only [?]; give the best OCR and concise natural Korean.",
    "Use type solid only for flat single-color bubble/caption backgrounds; use type nonsolid for artwork, screentone, texture, handwriting, labels, SFX, or uncertainty.",
    "Keep ordinary dialogue and caption Korean horizontal and natural unless the source is actual SFX/reaction lettering.",
    "For sound-effect or reaction lettering, ko must be bare Korean effect lettering only: no parentheses, brackets, quotes, stage directions, action descriptions, or explanatory notes.",
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
  for (const target of targets) {
    const cropBox = normalizeCropBox(target.cropBox, pageWidth, pageHeight);
    if (!cropBox) {
      continue;
    }
    const cropped = image.crop(cropBox);
    if (!cropped || cropped.isEmpty()) {
      continue;
    }
    const outputPath = path.join(outputDir, `item-${target.id}.png`);
    await writeFile(outputPath, cropped.toPNG());
    variants.push({
      role: "crop-retry",
      itemId: target.id,
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

function resolveConfiguredModelRepo(options = {}) {
  return String(options.modelRepo ?? process.env.MANGA_TRANSLATOR_MODEL_HF ?? "").trim() || DEFAULT_MODEL_HF;
}

function resolveConfiguredModelFile(options = {}) {
  return String(options.modelFile ?? process.env.LLAMA_ARG_HF_FILE ?? "").trim() || DEFAULT_HF_FILE;
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
  const explicit = String(options.ocrBboxProvider ?? process.env.MANGA_TRANSLATOR_OCR_BBOX_PROVIDER ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (isTruthy(process.env.MANGA_TRANSLATOR_DISABLE_OCR_BBOX)) {
    return "none";
  }
  if (isTruthy(process.env.MANGA_TRANSLATOR_PADDLEOCR_VL)) {
    return "paddleocr-vl";
  }
  if (String(process.env.MANGA_TRANSLATOR_OCR_BBOX_CMD ?? "").trim()) {
    return "external-command";
  }
  if (String(process.env.MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH ?? "").trim()) {
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

  const hintsPath = String(options.ocrBboxHintsPath ?? process.env.MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH ?? "").trim();
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
      emitRuntimeProgress(options, "ocr_running", "Paddle OCR GPU 실행 실패", diagnostic.message);
      throw createOcrRuntimeError(
        "Paddle OCR GPU 실행에 실패했습니다. GPU 설정을 쓰려면 CUDA가 보이는 GPU Paddle 런타임이 필요합니다. CPU로 바꾸면 계속 진행할 수 있습니다.",
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
      : normalizedHints.length === 0 || textEvidenceCount === 0;
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
    message: error instanceof Error ? error.message : String(error),
    ...extra
  };
}

async function runOcrBboxCommand(options = {}, provider = "external-command") {
  await mkdir(options.outputDir, { recursive: true });
  const outputPath = path.join(options.outputDir, "ocr-bbox-hints.json");
  const runtime = provider === "paddleocr-vl" ? await ensurePaddleOcrRuntime(options) : null;
  const command = buildOcrBboxCommand(options, provider, outputPath, runtime);
  emitRuntimeProgress(options, "ocr_running", "Paddle OCR 모델 다운로드/위치 분석 중", `장치: ${resolveOcrDeviceLabel(options)}`);
  const { stdout, stderr } = await runShellCommand(command, {
    timeoutMs: readPositiveInteger(process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS) || 600000,
    env: buildOcrRuntimeEnv(options, runtime),
    signal: options.abortSignal
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
  const handleProgressLine = (line) => {
      const progress = parseOcrBatchProgressLine(line);
      if (!progress) {
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
      timeoutMs: readPositiveInteger(process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS) || Math.max(600000, items.length * 300000),
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
    return { runtimeDir, runtimeVariant, packageDir, pythonPath: venvPython, prepared: true, usesTargetPackageDir: false, diagnostics };
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
    return { runtimeDir, runtimeVariant, packageDir, pythonPath: bootstrapPython, prepared: true, usesTargetPackageDir: true, diagnostics: [{ step: "embedded-python-ready", packageDir }] };
  }

  const targetInstallLooksBroken = hasOcrInstallMarker(packageDir, runtimeVariant) || hasExpectedOcrPackages(packageDir, options);
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

  if (!isTruthy(process.env.MANGA_TRANSLATOR_OCR_AUTO_INSTALL ?? "true")) {
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
  await writeOcrInstallMarker(packageDir, {
    runtimeVariant,
    installBatches,
    targetDir,
    installedAt: new Date().toISOString()
  });

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

  emitRuntimeProgress(options, "ocr_downloading", "Paddle OCR 설치 완료", packageSummary, {
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Paddle OCR 설치가 완료되었습니다."
  });

  return { runtimeDir, runtimeVariant, packageDir, pythonPath: installPython, prepared: true, usesTargetPackageDir: Boolean(targetDir), diagnostics };
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
        timeoutMs: readPositiveInteger(process.env.MANGA_TRANSLATOR_OCR_PIP_TIMEOUT_MS) || 1800000,
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
      process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR
        ?? options.ocrRuntimeDir
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
    process.env.MANGA_TRANSLATOR_OCR_PYTHON,
    process.env.MANGA_TRANSLATOR_PYTHON
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
  const explicit = process.env.MANGA_TRANSLATOR_OCR_ALLOW_SYSTEM_PYTHON ?? process.env.MANGA_TRANSLATOR_ALLOW_SYSTEM_PYTHON;
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
  const explicit = splitShellLikeEnv(process.env.MANGA_TRANSLATOR_OCR_PIP_PACKAGES);
  if (explicit.length > 0) {
    return [explicit];
  }

  if (!isOcrGpuRequested(options)) {
    const cpuPackages = splitShellLikeEnv(process.env.MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES);
    return [cpuPackages.length > 0 ? cpuPackages : DEFAULT_OCR_CPU_PIP_PACKAGES];
  }

  const gpuPackages = splitShellLikeEnv(process.env.MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES);
  if (gpuPackages.length > 0) {
    return [gpuPackages];
  }

  return [
    [
      process.env.MANGA_TRANSLATOR_OCR_GPU_PADDLE_PACKAGE || DEFAULT_OCR_GPU_PADDLE_PACKAGE,
      "--extra-index-url",
      resolveOcrGpuPackageIndexUrl(options)
    ],
    DEFAULT_OCR_GPU_EXTRA_PACKAGES
  ];
}

function splitShellLikeEnv(value) {
  const raw = String(value ?? "").trim();
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

function summarizeOcrInstallBatches(installBatches, options = {}) {
  const packageNames = installBatches
    .flat()
    .filter((part) => !part.startsWith("-") && !/^https?:\/\//i.test(part));
  const suffix = isOcrGpuRequested(options) ? ` (${resolveOcrGpuCudaTag()})` : "";
  return `${packageNames.join(", ")}${suffix}`;
}

function isOcrGpuRequested(options = {}) {
  return resolveOcrDevice(options).startsWith("gpu");
}

function resolveOcrGpuCudaTag() {
  const raw = String(
    process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG
      ?? process.env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG
      ?? process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA
      ?? DEFAULT_OCR_GPU_CUDA_TAG
  ).trim().toLowerCase();
  if (/^cu\d+$/.test(raw)) {
    return raw;
  }
  const digits = raw.replace(/\D/g, "");
  return digits ? `cu${digits}` : DEFAULT_OCR_GPU_CUDA_TAG;
}

function resolveOcrGpuPackageIndexUrl() {
  return String(
    process.env.MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL
      ?? process.env.MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL
      ?? `https://www.paddlepaddle.org.cn/packages/stable/${resolveOcrGpuCudaTag()}/`
  ).trim();
}

function resolveOcrRuntimeVariant(options = {}) {
  if (!isOcrGpuRequested(options)) {
    return "cpu";
  }
  return `gpu-${resolveOcrGpuCudaTag()}`.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase();
}

function resolveOcrPythonPackageDir(runtimeDir, options = {}) {
  return path.join(runtimeDir, `python-packages-${resolveOcrRuntimeVariant(options)}`);
}

function resolveOcrDevice(options = {}) {
  const explicitDevice = String(process.env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE ?? "").trim();
  if (explicitDevice) {
    return explicitDevice;
  }
  const value = String(process.env.MANGA_TRANSLATOR_OCR_DEVICE ?? options.ocrDevice ?? "cpu").trim().toLowerCase();
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
      timeoutMs: 60000,
      env: buildOcrRuntimeEnv(options, {
        runtimeDir: runtime?.runtimeDir || resolveOcrRuntimeDir(options),
        packageDir: runtime?.packageDir,
        includePackageDir: runtime?.includePackageDir
      }),
      signal: options.abortSignal
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

function buildPaddleOcrImportFailureMessage(importMessage, options = {}) {
  const suffix = isOcrGpuRequested(options)
    ? " GPU를 선택했지만 GPU Paddle/CUDA 검증에 실패했습니다. CPU로 바꾸거나 CUDA 드라이버와 GPU Paddle wheel을 확인하세요."
    : "";
  const detail = importMessage ? ` detail=${truncateText(importMessage, 1200)}` : "";
  return `PaddleOCR-VL runtime was installed but paddleocr/paddlex/paddle imports still fail.${suffix}${detail}`;
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

function hasOcrInstallMarker(packageDir, runtimeVariant) {
  try {
    const marker = JSON.parse(readFileSync(path.join(packageDir, OCR_INSTALL_MARKER_FILE), "utf8"));
    return marker?.runtimeVariant === runtimeVariant;
  } catch {
    return false;
  }
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

function clampProgressRatio(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return Math.max(0, Math.min(1, Number(fallback) || 0));
  }
  return Math.max(0, Math.min(1, number));
}

function parsePipRawProgress(line) {
  const text = String(line ?? "");
  const progressMatch = text.match(/\bProgress\s+(\d+)\s+of\s+(\d+)\b/i);
  if (progressMatch) {
    const current = Number(progressMatch[1]);
    const total = Number(progressMatch[2]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      return { current: Math.max(0, Math.min(current, total)), total };
    }
  }
  return null;
}

function parseOcrBatchProgressLine(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return null;
  }
  try {
    const payload = JSON.parse(text);
    const index = Number(payload?.index);
    const total = Number(payload?.total);
    if (!Number.isFinite(index) || !Number.isFinite(total) || index <= 0 || total <= 0) {
      return null;
    }
    const rawPhase = String(payload?.phase ?? "done").trim().toLowerCase();
    const phase = rawPhase === "start" ? "start" : "done";
    return {
      phase,
      index: Math.max(1, Math.min(Math.floor(index), Math.floor(total))),
      total: Math.floor(total),
      count: Number.isFinite(Number(payload?.count)) ? Math.max(0, Math.floor(Number(payload.count))) : 0
    };
  } catch {
    return null;
  }
}

function createOcrBatchProgressFilePoller(progressPath, onLine) {
  let timer = null;
  let consumedLines = 0;
  const readProgressFile = () => {
    if (!progressPath || !existsSync(progressPath)) {
      return;
    }
    let raw = "";
    try {
      raw = readFileSync(progressPath, "utf8");
    } catch {
      return;
    }
    if (!raw) {
      return;
    }
    const completeText = raw.endsWith("\n") || raw.endsWith("\r") ? raw : raw.replace(/[^\r\n]*$/, "");
    if (!completeText) {
      return;
    }
    const lines = completeText.split(/\r?\n/).filter(Boolean);
    for (let index = consumedLines; index < lines.length; index += 1) {
      onLine(lines[index]);
    }
    consumedLines = lines.length;
  };

  return {
    start() {
      readProgressFile();
      timer = setInterval(readProgressFile, 500);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      readProgressFile();
    }
  };
}

function sanitizeInstallLogLine(line) {
  const text = String(line ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateText(text, 220);
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function buildPaddleOcrImportCheckScript(options = {}) {
  const device = resolveOcrDevice(options);
  const lines = [
    "import paddle, paddlex, paddleocr"
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
  const hfHomeDir = options.hfHomeDir || process.env.HF_HOME || path.join(runtimeDir, "hf-cache");
  const hfHubCacheDir = options.hfHubCacheDir || process.env.HF_HUB_CACHE || process.env.HUGGINGFACE_HUB_CACHE || path.join(hfHomeDir, "hub");
  const packageDir = runtime?.packageDir || resolveOcrPythonPackageDir(runtimeDir, options);
  const includePackageDir = runtime?.includePackageDir ?? runtime?.usesTargetPackageDir ?? true;
  const pythonPath = includePackageDir ? packageDir : "";
  const ocrDevice = resolveOcrDevice(options);
  const pipCacheDir = path.join(runtimeDir, "pip-cache");
  const tempDir = path.join(runtimeDir, "tmp");
  const env = { ...process.env };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONUSERBASE;
  return {
    ...env,
    HF_HOME: hfHomeDir,
    HF_HUB_CACHE: hfHubCacheDir,
    HUGGINGFACE_HUB_CACHE: hfHubCacheDir,
    MANGA_TRANSLATOR_OCR_DEVICE: options.ocrDevice || process.env.MANGA_TRANSLATOR_OCR_DEVICE || "cpu",
    MANGA_TRANSLATOR_PADDLEOCR_DEVICE: ocrDevice,
    PYTHONPATH: pythonPath,
    PYTHONNOUSERSITE: "1",
    PYTHONUSERBASE: path.join(runtimeDir, "python-user-base"),
    PIP_CACHE_DIR: pipCacheDir,
    PADDLE_PDX_MODEL_SOURCE: process.env.PADDLE_PDX_MODEL_SOURCE || "huggingface",
    PADDLE_PDX_CACHE_HOME: process.env.PADDLE_PDX_CACHE_HOME || path.join(runtimeDir, "paddlex-cache"),
    PADDLE_PDX_HUGGING_FACE_ENDPOINT: process.env.PADDLE_PDX_HUGGING_FACE_ENDPOINT || "https://huggingface.co",
    PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT: process.env.PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT || "0",
    PIP_DISABLE_PIP_VERSION_CHECK: process.env.PIP_DISABLE_PIP_VERSION_CHECK || "1",
    TMP: tempDir,
    TEMP: tempDir,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1"
  };
}

function buildOcrBboxCommand(options = {}, provider, outputPath, runtime = null) {
  const template = String(options.ocrBboxCommand ?? process.env.MANGA_TRANSLATOR_OCR_BBOX_CMD ?? "").trim();
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

function runShellCommand(command, { timeoutMs, env, signal, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: env || process.env
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
        settleReject(createDetailedError("OCR bbox command timed out.", { command, timeoutMs, stdoutPreview: truncateText(stdout), stderrPreview: truncateText(stderr) }));
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
      windowsHide: true
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

function extractJsonText(rawText) {
  const text = String(rawText ?? "").trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    return text;
  }

  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstObject !== -1 && lastObject > firstObject && (firstArray === -1 || firstObject < firstArray)) {
    return text.slice(firstObject, lastObject + 1);
  }
  if (firstArray !== -1 && lastArray > firstArray) {
    return text.slice(firstArray, lastArray + 1);
  }
  return "";
}

function normalizeOcrBboxHintPayload(payload, options = {}) {
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const candidates = collectOcrBboxCandidates(payload);
  const hints = [];

  for (const candidate of candidates) {
    const box = normalizeOcrBboxCandidate(candidate, originalWidth, originalHeight, payload);
    if (!box) {
      continue;
    }
    const label = candidate.label ?? candidate.type ?? candidate.category ?? candidate.class ?? candidate.class_name ?? "text";
    if (isIgnoredOcrLabel(label)) {
      continue;
    }
    const ocrText = sanitizeOcrTextForPrompt(readOcrCandidateText(candidate));
    hints.push({
      id: hints.length + 1,
      label: sanitizeHintLabel(label),
      ...box,
      ...(Number.isFinite(Number(candidate.score ?? candidate.confidence)) ? { score: Number(candidate.score ?? candidate.confidence) } : {}),
      ...(ocrText ? { ocrText } : {})
    });
  }

  return hints.slice(0, 80);
}

function collectOcrBboxCandidates(payload) {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.blocks)) return payload.blocks;
  if (Array.isArray(payload.parsing_res_list)) return payload.parsing_res_list;
  if (Array.isArray(payload.layout_det_res?.boxes)) return payload.layout_det_res.boxes;
  if (Array.isArray(payload.pages)) return payload.pages.flatMap(collectOcrBboxCandidates);
  if (Array.isArray(payload.results)) return payload.results.flatMap(collectOcrBboxCandidates);
  if (payload.result && typeof payload.result === "object") return collectOcrBboxCandidates(payload.result);
  if (payload.data && typeof payload.data === "object") return collectOcrBboxCandidates(payload.data);
  return [];
}

function normalizeOcrBboxCandidate(candidate, originalWidth, originalHeight, payload) {
  const rawBox = readRawOcrBox(candidate);
  if (!rawBox) {
    return null;
  }

  const payloadSpace = String(payload?.coordinateSpace ?? payload?.bboxCoordinateSpace ?? candidate.coordinateSpace ?? "").toLowerCase();
  const sourceWidth = readPositiveInteger(payload?.width ?? payload?.imageWidth ?? candidate.imageWidth) || originalWidth;
  const sourceHeight = readPositiveInteger(payload?.height ?? payload?.imageHeight ?? candidate.imageHeight) || originalHeight;
  let { x1, y1, x2, y2 } = rawBox;

  if (payloadSpace.includes("1000") && originalWidth && originalHeight) {
    x1 = (x1 / 1000) * originalWidth;
    x2 = (x2 / 1000) * originalWidth;
    y1 = (y1 / 1000) * originalHeight;
    y2 = (y2 / 1000) * originalHeight;
  } else if (sourceWidth && sourceHeight && originalWidth && originalHeight && (sourceWidth !== originalWidth || sourceHeight !== originalHeight)) {
    x1 = (x1 / sourceWidth) * originalWidth;
    x2 = (x2 / sourceWidth) * originalWidth;
    y1 = (y1 / sourceHeight) * originalHeight;
    y2 = (y2 / sourceHeight) * originalHeight;
  }

  const left = Math.max(0, Math.round(Math.min(x1, x2)));
  const top = Math.max(0, Math.round(Math.min(y1, y2)));
  const right = originalWidth ? Math.min(originalWidth, Math.round(Math.max(x1, x2))) : Math.round(Math.max(x1, x2));
  const bottom = originalHeight ? Math.min(originalHeight, Math.round(Math.max(y1, y2))) : Math.round(Math.max(y1, y2));
  if (right - left < 2 || bottom - top < 2) {
    return null;
  }
  return { x1: left, y1: top, x2: right, y2: bottom };
}

function readRawOcrBox(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const direct = boxFromNumericFields(candidate);
  if (direct) {
    return direct;
  }

  for (const key of ["bbox", "box", "rect", "rectangle", "position"]) {
    const box = boxFromArrayOrObject(candidate[key]);
    if (box) {
      return box;
    }
  }

  for (const key of ["polygon", "poly", "points", "polygon_points", "rec_poly", "det_poly"]) {
    const box = boxFromPolygon(candidate[key]);
    if (box) {
      return box;
    }
  }

  return null;
}

function boxFromNumericFields(value) {
  const x1 = Number(value.x1 ?? value.left);
  const y1 = Number(value.y1 ?? value.top);
  const x2 = Number(value.x2 ?? value.right);
  const y2 = Number(value.y2 ?? value.bottom);
  if ([x1, y1, x2, y2].every(Number.isFinite)) {
    return { x1, y1, x2, y2 };
  }

  const x = Number(value.x);
  const y = Number(value.y);
  const w = Number(value.w ?? value.width);
  const h = Number(value.h ?? value.height);
  if ([x, y, w, h].every(Number.isFinite)) {
    return { x1: x, y1: y, x2: x + w, y2: y + h };
  }

  return null;
}

function boxFromArrayOrObject(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length >= 4 && value.every((item) => typeof item === "number" || typeof item === "string")) {
      const numbers = value.slice(0, 4).map(Number);
      if (numbers.every(Number.isFinite)) {
        return { x1: numbers[0], y1: numbers[1], x2: numbers[2], y2: numbers[3] };
      }
    }
    return boxFromPolygon(value);
  }
  if (typeof value === "object") {
    return boxFromNumericFields(value);
  }
  return null;
}

function boxFromPolygon(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const points = [];
  for (const point of value) {
    if (Array.isArray(point) && point.length >= 2) {
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x, y });
      }
    } else if (point && typeof point === "object") {
      const x = Number(point.x);
      const y = Number(point.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x, y });
      }
    }
  }
  if (points.length === 0) {
    return null;
  }
  return {
    x1: Math.min(...points.map((point) => point.x)),
    y1: Math.min(...points.map((point) => point.y)),
    x2: Math.max(...points.map((point) => point.x)),
    y2: Math.max(...points.map((point) => point.y))
  };
}

function isIgnoredOcrLabel(label) {
  const normalized = sanitizeHintLabel(label);
  return [
    "image",
    "header_image",
    "footer_image",
    "chart",
    "table",
    "figure",
    "seal",
    "formula",
    "display_formula",
    "inline_formula",
    "number",
    "footer",
    "header"
  ].includes(normalized);
}

function buildLaunchArgs(options) {
  const launchTarget = inspectModelLaunch(options);
  if (launchTarget.launchMode === "local" && !launchTarget.modelPath) {
    throw createDetailedError("로컬 모델 파일 경로가 설정되지 않았습니다.", {
      optionSummary: buildOptionSummary(options)
    });
  }
  const useBeellamaGemmaLaunch = shouldUseBeellamaGemmaLaunch(options);
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
    process.env.MANGA_TRANSLATOR_REPEAT_LAST_N || "256",
    "--repeat-penalty",
    process.env.MANGA_TRANSLATOR_REPEAT_PENALTY || "1.08",
    "--presence-penalty",
    "0",
    "--frequency-penalty",
    "0",
    ...(useBeellamaGemmaLaunch ? [] : ["--fit", "on", "--fit-target", String(options.fitTargetMb)]),
    "-ngl",
    "all",
    "-fa",
    "on",
    "--temp",
    String(options.temperature ?? process.env.MANGA_TRANSLATOR_TEMPERATURE ?? "0.2"),
    "--top-k",
    String(options.topK ?? process.env.MANGA_TRANSLATOR_TOP_K ?? "64"),
    "--top-p",
    String(options.topP ?? process.env.MANGA_TRANSLATOR_TOP_P ?? "0.95"),
    "--min-p",
    String(process.env.MANGA_TRANSLATOR_MIN_P ?? "0.0"),
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
    args.push("--kv-unified", "--jinja", "--no-mmap", "--mlock", "--no-host");
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
  if (resolveConfiguredModelSource(options) === "local") {
    const localModelPath = resolveConfiguredLocalModelPath(options);
    return path.basename(localModelPath || "") === DEFAULT_HF_FILE;
  }
  return resolveConfiguredModelRepo(options) === DEFAULT_MODEL_HF || resolveConfiguredModelFile(options) === DEFAULT_HF_FILE;
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
  if (options.reuseServer && await isReachable(baseUrl)) {
    return { baseUrl, child: null, startedByScript: false };
  }

  const serverPath = options.serverPath || process.env.LLAMA_SERVER_PATH || defaultServerPath(options);
  if (!existsSync(serverPath)) {
    throw createDetailedError("Bundled llama-server binary is missing.", {
      baseUrl,
      serverPath,
      optionSummary: buildOptionSummary(options)
    });
  }

  const childEnv = {
    ...process.env,
    MANGA_TRANSLATOR_LLAMA_PORT: String(options.port)
  };
  const hfHomeDir = resolveHfHomeDir(options);
  const hfHubCacheDir = resolveHubCacheDir(options);
  if (hfHomeDir) {
    childEnv.HF_HOME = hfHomeDir;
  }
  if (hfHubCacheDir) {
    childEnv.HF_HUB_CACHE = hfHubCacheDir;
    childEnv.HUGGINGFACE_HUB_CACHE = hfHubCacheDir;
  }

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
  buildResponsesRequestBody,
  collectRequiredHfDownloads,
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  convertImageToPngBufferWithFfmpeg,
  enhanceBitmapBuffer,
  extractModelOutputText,
  getOverlayPrompt,
  getScaledSize,
  parseOcrBatchProgressLine,
  parsePipRawProgress,
  resolveOcrInstallBatchProgressRanges,
  resolveFfmpegPath,
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
