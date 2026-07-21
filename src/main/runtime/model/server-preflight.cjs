// @ts-check
const { spawn } = require("node:child_process");
const path = require("node:path");
const { runtimeOverrideEnv } = require("../simple-page-child-env.cjs");
const { resolveWorkingDir } = require("../simple-page-cache-paths.cjs");
const {
  hasRequiredLlamaRuntimeFiles,
  isBuiltInGemmaRuntimeModel,
  isGemma31BModel,
  missingRequiredLlamaRuntimeFiles,
  resolvePreferredLlamaRuntime,
} = require("../simple-page-runtime-paths.cjs");
const { looksLikeGemma4Model } = require("../simple-page-launch-args.cjs");
const {
  shrinkBuffer,
  terminateChildProcessTree,
} = require("../simple-page-shell-utils.cjs");
const {
  createDetailedError,
  truncateText,
} = require("../simple-page-runtime-common.cjs");
const { buildLlamaServerEnv } = require("./server-environment.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").LlamaRuntimeDescriptor} LlamaRuntimeDescriptor */
/** @typedef {{ code: number; stdout: string; stderr: string }} RuntimeProbeResult */

/** @param {string | null | undefined} serverPath @param {RuntimeOptions} [options] */
function isIncompleteManagedLlamaRuntime(serverPath, options = {}) {
  if (!serverPath || !isBuiltInGemmaRuntimeModel(options)) return false;
  const runtime = resolvePreferredLlamaRuntime(options);
  assertMetalDflashConfiguration(serverPath, runtime, options);
  const runtimeDir = path.dirname(serverPath);
  if (path.basename(runtimeDir).toLowerCase() !== runtime.dir.toLowerCase())
    return false;
  return !hasRequiredLlamaRuntimeFiles(runtimeDir, runtime);
}

/** @param {string} serverPath @param {LlamaRuntimeDescriptor & { dflashRing?: unknown }} runtime @param {RuntimeOptions & { useDraft?: unknown }} options */
function assertMetalDflashConfiguration(serverPath, runtime, options) {
  if (
    String(runtime.backend || "").toLowerCase() !== "metal" ||
    !isGemma31BModel(options)
  ) {
    return;
  }
  const env = buildLlamaServerEnv(serverPath, options);
  if (
    runtime.kind === "beellama-metal" &&
    runtime.dflashRing === "cpu" &&
    options.useDraft === true &&
    env.GGML_DFLASH_GPU_RING === "0"
  ) {
    return;
  }
  throw createDetailedError(
    "31B Apple Silicon 빌드는 BeeLlama DFlash CPU-ring 경로로만 실행할 수 있습니다. 단순 31B 실행으로 후퇴하지 않도록 중단합니다.",
    {
      serverPath,
      runtime: runtime.id,
      runtimeKind: runtime.kind,
      runtimeBackend: runtime.backend,
      dflashRing: runtime.dflashRing,
      useDraft: options.useDraft,
      dflashGpuRing: env.GGML_DFLASH_GPU_RING,
    },
  );
}

/** @param {string} serverPath @param {RuntimeOptions} [options] */
async function verifyLlamaRuntimePreflight(serverPath, options = {}) {
  if (!looksLikeGemma4Model(options)) return;
  const runtime = resolvePreferredLlamaRuntime(options);
  assertManagedRuntimeComplete(serverPath, runtime);
  if (!shouldProbeRuntime(runtime, options)) return;
  const result = await runLlamaRuntimeProbe(
    serverPath,
    options,
    ["--list-devices"],
    resolveLlamaRuntimePreflightTimeoutMs(runtime, options),
  );
  assertSuccessfulProbe(serverPath, runtime, result);
  assertGpuBackedProbe(serverPath, runtime, result);
}

/** @param {string} serverPath @param {LlamaRuntimeDescriptor} runtime */
function assertManagedRuntimeComplete(serverPath, runtime) {
  const runtimeDir = path.dirname(serverPath);
  if (path.basename(runtimeDir).toLowerCase() !== runtime.dir.toLowerCase())
    return;
  const missingFiles = missingRequiredLlamaRuntimeFiles(runtimeDir, runtime);
  if (missingFiles.length === 0) return;
  throw createDetailedError(
    "Gemma 실행 런타임이 불완전합니다. GPU 런타임 파일을 포함해 다시 설치해야 합니다.",
    {
      serverPath,
      runtimeDir,
      runtime: runtime.id,
      missingFiles,
    },
  );
}

/** @param {LlamaRuntimeDescriptor} runtime @param {RuntimeOptions} options */
function shouldProbeRuntime(runtime, options) {
  const backend = String(runtime.backend || "cuda").toLowerCase();
  const supportedPlatform =
    process.platform === "win32" ||
    ["rocm", "vulkan", "metal"].includes(backend);
  return (
    supportedPlatform &&
    !runtimeOverrideEnv("MGT_SKIP_LLAMA_RUNTIME_PREFLIGHT", options)
  );
}

/** @param {string} serverPath @param {LlamaRuntimeDescriptor} runtime @param {RuntimeProbeResult} result */
function assertSuccessfulProbe(serverPath, runtime, result) {
  if (result.code === 0) return;
  throw createDetailedError(
    `llama-server ${formatLlamaBackendLabel(runtime.backend)} 런타임 검증에 실패했습니다.`,
    {
      serverPath,
      runtimeBackend: runtime.backend,
      code: result.code,
      stdout: truncateText(result.stdout, 4000),
      stderr: truncateText(result.stderr, 4000),
    },
  );
}

/** @param {string} serverPath @param {LlamaRuntimeDescriptor} runtime @param {RuntimeProbeResult} result */
function assertGpuBackedProbe(serverPath, runtime, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (llamaRuntimeProbeLooksGpuBacked(output, runtime.backend)) return;
  throw createDetailedError(
    `llama-server가 ${gpuBackendLabel(runtime.backend)}를 찾지 못했습니다. CPU 실행으로 조용히 넘어가지 않도록 중단합니다.`,
    {
      serverPath,
      runtimeBackend: runtime.backend,
      stdout: truncateText(result.stdout, 4000),
      stderr: truncateText(result.stderr, 4000),
    },
  );
}

/** @param {unknown} backend */
function gpuBackendLabel(backend) {
  const normalized = String(backend || "cuda").toLowerCase();
  if (normalized === "vulkan") return "Vulkan/AMD GPU";
  if (normalized === "metal") return "Metal/Apple Silicon GPU";
  if (normalized === "rocm" || normalized === "hip") return "ROCm/HIP GPU";
  return "CUDA GPU";
}

/** @param {Partial<LlamaRuntimeDescriptor>} [runtime] @param {RuntimeOptions & { llamaRuntimePreflightTimeoutMs?: unknown }} [options] */
function resolveLlamaRuntimePreflightTimeoutMs(runtime = {}, options = {}) {
  const configured = Number(
    options.llamaRuntimePreflightTimeoutMs ??
      runtimeOverrideEnv("MGT_LLAMA_RUNTIME_PREFLIGHT_TIMEOUT_MS", options) ??
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_LLAMA_RUNTIME_PREFLIGHT_TIMEOUT_MS",
        options,
      ),
  );
  if (Number.isFinite(configured) && configured > 0)
    return Math.max(1000, Math.round(configured));
  if (String(runtime.backend || "").toLowerCase() === "metal") return 60000;
  return ["rocm", "hip"].includes(
    String(runtime.backend || "cuda").toLowerCase(),
  )
    ? 120000
    : 20000;
}

/** @param {unknown} [backend] */
function formatLlamaBackendLabel(backend = "cuda") {
  const normalized = String(backend || "cuda").toLowerCase();
  if (normalized === "vulkan") return "Vulkan";
  if (normalized === "metal") return "Metal";
  if (normalized === "rocm" || normalized === "hip") return "ROCm/HIP";
  return "CUDA";
}

/** @param {unknown} output @param {unknown} [backend] */
function llamaRuntimeProbeLooksGpuBacked(output, backend = "cuda") {
  const text = String(output || "");
  const normalized = String(backend || "cuda").toLowerCase();
  if (normalized === "vulkan") return /(vulkan|radeon|amd|gpu)/i.test(text);
  if (normalized === "metal") {
    return (
      (/metal/i.test(text) && /(apple|gpu|m[1-9])/i.test(text)) ||
      /^\s*MTL\d+:\s*Apple\s+M\d+/im.test(text)
    );
  }
  if (normalized === "rocm" || normalized === "hip")
    return /(rocm|hip|radeon|amd|gpu)/i.test(text);
  return /(cuda|nvidia|geforce|rtx|gpu)/i.test(text);
}

/** @param {string} serverPath @param {RuntimeOptions} [options] @param {string[]} [args] @param {number} [timeoutMs] @returns {Promise<RuntimeProbeResult>} */
function runLlamaRuntimeProbe(
  serverPath,
  options = {},
  args = [],
  timeoutMs = 20000,
) {
  return new Promise((resolve) => {
    const state = { stdout: "", stderr: "", settled: false };
    const child = spawn(serverPath, args, {
      cwd: resolveWorkingDir(options),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: buildLlamaServerEnv(serverPath, options),
    });
    bindProbeOutput(child, state);
    const timer = setTimeout(
      () => finishTimedOutProbe(child, state, resolve, timeoutMs),
      timeoutMs,
    );
    child.once("error", (error) =>
      finishProbe(
        state,
        resolve,
        timer,
        -1,
        `${state.stderr}\n${error.message}`,
      ),
    );
    child.once("close", (code) =>
      finishProbe(state, resolve, timer, code ?? -1, state.stderr),
    );
  });
}

/** @param {import("node:child_process").ChildProcess} child @param {{ stdout: string; stderr: string }} state */
function bindProbeOutput(child, state) {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    state.stdout = shrinkBuffer(state.stdout, chunk, 8000);
  });
  child.stderr?.on("data", (chunk) => {
    state.stderr = shrinkBuffer(state.stderr, chunk, 8000);
  });
}

/** @param {import("node:child_process").ChildProcess} child @param {{ stdout: string; stderr: string; settled: boolean }} state @param {(result: RuntimeProbeResult) => void} resolve @param {number} timeoutMs */
function finishTimedOutProbe(child, state, resolve, timeoutMs) {
  terminateChildProcessTree(child);
  finishProbe(
    state,
    resolve,
    null,
    -1,
    `${state.stderr}\nllama-server probe timed out after ${timeoutMs}ms`,
  );
}

/** @param {{ stdout: string; stderr: string; settled: boolean }} state @param {(result: RuntimeProbeResult) => void} resolve @param {ReturnType<typeof setTimeout> | null} timer @param {number} code @param {string} stderr */
function finishProbe(state, resolve, timer, code, stderr) {
  if (state.settled) return;
  state.settled = true;
  if (timer) clearTimeout(timer);
  resolve({ code, stdout: state.stdout, stderr });
}

module.exports = {
  isIncompleteManagedLlamaRuntime,
  assertMetalDflashConfiguration,
  llamaRuntimeProbeLooksGpuBacked,
  resolveLlamaRuntimePreflightTimeoutMs,
  verifyLlamaRuntimePreflight,
};
