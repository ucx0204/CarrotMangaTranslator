const os = require("node:os");
const path = require("node:path");

/** @typedef {{ name: string; batch?: number; ubatch?: number; ctx?: number; fitTargetMb?: number; imageMinTokens?: number; imageMaxTokens?: number; kvOffload?: boolean; mmprojOffload?: boolean; gpuLayers?: number | string; noHost?: boolean; serverPath?: string; modelRepo?: string; modelFile?: string; mmprojRepo?: string; mmprojFile?: string; cacheTypeK?: string; cacheTypeV?: string; extraArgs?: string[]; threads?: number; threadsBatch?: number; poll?: number; pollBatch?: boolean; prioBatch?: number; cacheIdleSlots?: unknown; cacheReuse?: unknown; [key: string]: unknown }} BenchmarkCandidate */

/** @param {string} name @param {number} fallback */
function readIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.round(value) : fallback;
}
/** @param {string} name @param {number} fallback */
function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_SAMPLE_PATHS = [
  "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas\\Manga Mura (JA)\\転生しました、サラナ・キンジェです。ごきげんよう。 ～優雅なスローライフで大忙し～ 転生しました、サラナ・キンジェです。ごきげんよう。 ～婚約破棄されたので田舎で気ままに暮らしたいと思います～\\第3話_ 第3話\\003.jpeg",
  "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas\\Rawkuma (JA)\\Akuyaku ga Ippai Detekuru Eroge no Kimo Debu Akuyaku Kizoku ni Tensei Shita\\Chapter 3.1\\001.jpeg",
  "C:\\Users\\sam40\\AppData\\Local\\Tachidesk\\downloads\\mangas\\Rawkuma (JA)\\Danshi Koukousei, Otome Game no Akuyaku Reijou ni Tensei Suru\\Chapter 2\\001.jpeg",
];

const RUNS_PER_CANDIDATE = readIntEnv("MANGA_PERF_RUNS", 2);
const GPU_SAMPLE_INTERVAL_MS = readIntEnv(
  "MANGA_PERF_GPU_SAMPLE_INTERVAL_MS",
  1000,
);
const VRAM_DELTA_LIMIT_MB = readIntEnv("MANGA_PERF_VRAM_DELTA_LIMIT_MB", 300);
const MIN_WALL_IMPROVEMENT = readNumberEnv(
  "MANGA_PERF_MIN_WALL_IMPROVEMENT",
  0.05,
);
const BASE_PORT = readIntEnv("MANGA_PERF_BASE_PORT", 18240);
const SKIP_OCR = String(process.env.MANGA_PERF_SKIP_OCR || "").trim() === "1";
const REUSE_OCR_DIR = String(process.env.MANGA_PERF_REUSE_OCR_DIR || "").trim();
const CPU_THREAD_GUESS = Math.max(4, Math.min(os.cpus().length || 8, 16));
/** @type {BenchmarkCandidate[]} */
const CANDIDATES = [
  { name: "baseline-b1024-ub1024", batch: 1024, ubatch: 1024 },
  {
    name: "gpu-kv-ngl58",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    gpuLayers: 58,
    noHost: false,
  },
  {
    name: "gpu-kv-ngl58-no-warmup",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    gpuLayers: 58,
    noHost: false,
    extraArgs: ["--no-warmup"],
  },
  {
    name: "beellama-ctx7168-img512-ub512",
    batch: 1024,
    ubatch: 512,
    ctx: 7168,
    kvOffload: true,
    imageMinTokens: 512,
    imageMaxTokens: 512,
  },
  {
    name: "beellama-ctx6144-img512-ub512",
    batch: 1024,
    ubatch: 512,
    ctx: 6144,
    kvOffload: true,
    imageMinTokens: 512,
    imageMaxTokens: 512,
  },
  {
    name: "beellama-26b-a4b-iq3s-q8-mmproj",
    batch: 1024,
    ubatch: 512,
    ctx: 7168,
    kvOffload: true,
    imageMinTokens: 512,
    imageMaxTokens: 512,
    modelRepo:
      "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-i1-GGUF",
    modelFile: "gemma-4-26B-A4B-it-ultra-uncensored-heretic.i1-IQ3_S.gguf",
    mmprojRepo: "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF",
    mmprojFile: "gemma-4-26B-A4B-it-ultra-uncensored-heretic.mmproj-Q8_0.gguf",
  },
  {
    name: "official-llama-b8833-baseline",
    batch: 1024,
    ubatch: 1024,
    serverPath: path.join(
      ROOT,
      "tools",
      "llama-b8833-cuda12.4",
      "llama-server.exe",
    ),
  },
  {
    name: "official-llama-b8833-fit14g",
    batch: 1024,
    ubatch: 1024,
    fitTargetMb: 9000,
    gpuLayers: "fit",
    extraArgs: ["--fit", "on", "--fit-target", "9000"],
    serverPath: path.join(
      ROOT,
      "tools",
      "llama-b8833-cuda12.4",
      "llama-server.exe",
    ),
  },
  {
    name: "official-llama-b8833-fit13g",
    batch: 1024,
    ubatch: 1024,
    fitTargetMb: 10000,
    gpuLayers: "fit",
    extraArgs: ["--fit", "on", "--fit-target", "10000"],
    serverPath: path.join(
      ROOT,
      "tools",
      "llama-b8833-cuda12.4",
      "llama-server.exe",
    ),
  },
  {
    name: "official-llama-b8833-fit12g",
    batch: 1024,
    ubatch: 1024,
    fitTargetMb: 12000,
    gpuLayers: "fit",
    extraArgs: ["--fit", "on", "--fit-target", "12000"],
    serverPath: path.join(
      ROOT,
      "tools",
      "llama-b8833-cuda12.4",
      "llama-server.exe",
    ),
  },
  {
    name: "official-llama-b8833-ngl58",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    gpuLayers: 58,
    noHost: false,
    serverPath: path.join(
      ROOT,
      "tools",
      "llama-b8833-cuda12.4",
      "llama-server.exe",
    ),
  },
  { name: "b512-ub1024", batch: 512, ubatch: 1024 },
  { name: "b1536-ub1024", batch: 1536, ubatch: 1024 },
  { name: "gpu-kv-b1024-ub1024", batch: 1024, ubatch: 1024, kvOffload: true },
  { name: "gpu-kv-b1024-ub768", batch: 1024, ubatch: 768, kvOffload: true },
  { name: "gpu-kv-b1024-ub512", batch: 1024, ubatch: 512, kvOffload: true },
  {
    name: "gpu-kv-vturbo4",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    cacheTypeK: "q4_0",
    cacheTypeV: "turbo4",
  },
  {
    name: "gpu-kv-turbo4",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    cacheTypeK: "turbo4",
    cacheTypeV: "turbo4",
  },
  {
    name: "gpu-kv-vturbo3",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    cacheTypeK: "q4_0",
    cacheTypeV: "turbo3",
  },
  {
    name: "gpu-kv-turbo3",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    cacheTypeK: "turbo3",
    cacheTypeV: "turbo3",
  },
  {
    name: "gpu-kv-turbo3-tcq",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    cacheTypeK: "turbo3_tcq",
    cacheTypeV: "turbo3_tcq",
  },
  {
    name: "gpu-kv-turbo2",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    cacheTypeK: "turbo2",
    cacheTypeV: "turbo2",
  },
  {
    name: "mmproj-gpu-cpu-kv",
    batch: 1024,
    ubatch: 1024,
    kvOffload: false,
    mmprojOffload: true,
  },
  {
    name: "mmproj-gpu-gpu-kv",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    mmprojOffload: true,
  },
  {
    name: "mmproj-gpu-gpu-kv-ub768",
    batch: 1024,
    ubatch: 768,
    kvOffload: true,
    mmprojOffload: true,
  },
  {
    name: "mmproj-gpu-gpu-kv-ub512",
    batch: 1024,
    ubatch: 512,
    kvOffload: true,
    mmprojOffload: true,
  },
  {
    name: "mmproj-gpu-gpu-kv-ctx6144-ub512",
    batch: 1024,
    ubatch: 512,
    ctx: 6144,
    kvOffload: true,
    mmprojOffload: true,
  },
  {
    name: "mmproj-gpu-gpu-kv-turbo4",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    mmprojOffload: true,
    cacheTypeK: "turbo4",
    cacheTypeV: "turbo4",
  },
  {
    name: "mmproj-gpu-gpu-kv-turbo3",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    mmprojOffload: true,
    cacheTypeK: "turbo3",
    cacheTypeV: "turbo3",
  },
  {
    name: "gpu-kv-ctx4096",
    batch: 1024,
    ubatch: 1024,
    ctx: 4096,
    kvOffload: true,
  },
  {
    name: "gpu-kv-ctx5120",
    batch: 1024,
    ubatch: 1024,
    ctx: 5120,
    kvOffload: true,
  },
  {
    name: "gpu-kv-ctx6144",
    batch: 1024,
    ubatch: 1024,
    ctx: 6144,
    kvOffload: true,
  },
  {
    name: "gpu-kv-ctx7168",
    batch: 1024,
    ubatch: 1024,
    ctx: 7168,
    kvOffload: true,
  },
  {
    name: "gpu-kv-ctx7680",
    batch: 1024,
    ubatch: 1024,
    ctx: 7680,
    kvOffload: true,
  },
  {
    name: "gpu-kv-no-warmup",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--no-warmup"],
  },
  {
    name: "gpu-kv-swa768",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--override-kv", "gemma4.attention.sliding_window=int:768"],
  },
  {
    name: "gpu-kv-swa512",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--override-kv", "gemma4.attention.sliding_window=int:512"],
  },
  {
    name: "gpu-kv-no-repack",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--no-repack"],
  },
  {
    name: "gpu-kv-no-op-offload",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--no-op-offload"],
  },
  {
    name: "gpu-kv-no-repack-no-op-offload",
    batch: 1024,
    ubatch: 1024,
    kvOffload: true,
    extraArgs: ["--no-repack", "--no-op-offload"],
  },
  { name: "gpu-kv-b512-ub1024", batch: 512, ubatch: 1024, kvOffload: true },
  {
    name: "cpu-feed-b1024-ub1024",
    batch: 1024,
    ubatch: 1024,
    poll: 100,
    pollBatch: true,
    prioBatch: 2,
    threadsBatch: CPU_THREAD_GUESS,
  },
  {
    name: "cpu-feed-b1536-ub1024",
    batch: 1536,
    ubatch: 1024,
    poll: 100,
    pollBatch: true,
    prioBatch: 2,
    threadsBatch: CPU_THREAD_GUESS,
  },
  {
    name: "cpu-feed-b1536-ub1536",
    batch: 1536,
    ubatch: 1536,
    poll: 100,
    pollBatch: true,
    prioBatch: 2,
    threadsBatch: CPU_THREAD_GUESS,
  },
];
const CANDIDATE_FILTER = String(process.env.MANGA_PERF_CANDIDATES || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

module.exports = {
  BASE_PORT,
  CANDIDATES,
  CANDIDATE_FILTER,
  DEFAULT_SAMPLE_PATHS,
  GPU_SAMPLE_INTERVAL_MS,
  MIN_WALL_IMPROVEMENT,
  REUSE_OCR_DIR,
  ROOT,
  RUNS_PER_CANDIDATE,
  SKIP_OCR,
  VRAM_DELTA_LIMIT_MB,
  readIntEnv,
};
