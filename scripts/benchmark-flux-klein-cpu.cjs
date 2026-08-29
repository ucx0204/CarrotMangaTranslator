// @ts-check

const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { cpus, platform, release, tmpdir, totalmem } = require("node:os");
const { basename, join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { PNG } = require("pngjs");

/** @typedef {"unspecified" | "cpu-only" | "nvidia-cpu-selected"} BenchmarkScenario */
/** @typedef {{ workingSetBytes: number; privateBytes: number }} MemorySample */
/** @typedef {{ firstWorkingSetBytes: number | null; readyWorkingSetBytes: number | null; peakWorkingSetBytes: number; peakPrivateBytes: number; samples: number }} MemoryMetrics */
/** @typedef {{ backend: string; cpu_only: boolean; cuda_compiled: boolean; metal_compiled: boolean; [key: string]: unknown }} RunnerCapabilities */
/** @typedef {{ ok: boolean; elapsed_ms: number; error?: string | null }} WorkerResponse */

const args = parseArgs(process.argv.slice(2));
const runner = requireFile(args.runner, "--runner");
const transformer = requireFile(args.transformer, "--transformer");
const vae = requireFile(args.vae, "--vae");
const capabilities = readCpuRunnerCapabilities(runner);
const scenario = parseScenario(args.scenario ?? "unspecified");
const expectedMemoryGb = args["expected-memory-gb"]
  ? parsePositiveNumber(args["expected-memory-gb"], "--expected-memory-gb")
  : null;
assertHardwareScenario(scenario, expectedMemoryGb);
const size = parsePositiveInteger(args.size ?? "256", "--size");
const steps = parsePositiveInteger(args.steps ?? "4", "--steps");
const timeoutMinutes = parsePositiveNumber(
  args["timeout-minutes"] ?? "120",
  "--timeout-minutes",
);
const keepArtifacts = args["keep-artifacts"] === "true";
const outputJson = args["output-json"]
  ? resolve(String(args["output-json"]))
  : null;
const runDir = mkdtempSync(join(tmpdir(), "mgt-flux-cpu-benchmark-"));
const inputPath = join(runDir, "input.png");
const maskPath = join(runDir, "mask.png");
const outputPath = join(runDir, "output.png");

writeBenchmarkImages(inputPath, maskPath, size);

void runBenchmark().then(
  (result) => {
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (outputJson) {
      writeFileSync(outputJson, text, "utf8");
    }
    process.stdout.write(text);
    if (!keepArtifacts) {
      rmSync(runDir, { recursive: true, force: true });
    }
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.stderr.write(`Benchmark artifacts preserved at ${runDir}\n`);
    process.exitCode = 1;
  },
);

async function runBenchmark() {
  const startedAt = Date.now();
  const child = spawn(
    runner,
    [
      "--transformer-path",
      transformer,
      "--vae-path",
      vae,
      "--steps",
      String(steps),
      "--max-pixels",
      String(size * size),
      "--mask-padding",
      "16",
    ],
    {
      cwd: runDir,
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG || "warn",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (!child.pid) {
    throw new Error("CPU runner did not return a process id");
  }

  /** @type {MemoryMetrics} */
  const memory = {
    firstWorkingSetBytes: null,
    readyWorkingSetBytes: null,
    peakWorkingSetBytes: 0,
    peakPrivateBytes: 0,
    samples: 0,
  };
  let latestWorkingSetBytes = 0;
  const stopMemorySampler = startMemorySampler(child.pid, (sample) => {
    memory.firstWorkingSetBytes ??= sample.workingSetBytes;
    latestWorkingSetBytes = sample.workingSetBytes;
    memory.peakWorkingSetBytes = Math.max(
      memory.peakWorkingSetBytes,
      sample.workingSetBytes,
    );
    memory.peakPrivateBytes = Math.max(
      memory.peakPrivateBytes,
      sample.privateBytes,
    );
    memory.samples += 1;
  });

  let stderr = "";
  let stderrLineBuffer = "";
  let stdoutLineBuffer = "";
  /** @type {string[]} */
  const stdoutLogLines = [];
  /** @type {number | null} */
  let readyAt = null;
  /** @type {number | null} */
  let modelLoadMs = null;
  /** @type {number | null} */
  let promptEmbeddingMs = null;
  /** @type {WorkerResponse | null} */
  let response = null;
  /** @type {number | null} */
  let requestSentAt = null;
  let timedOut = false;

  const timeout = setTimeout(
    () => {
      timedOut = true;
      child.kill();
    },
    timeoutMinutes * 60 * 1000,
  );

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
    stderrLineBuffer += chunk;
    const lines = stderrLineBuffer.split(/\r?\n/);
    stderrLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      modelLoadMs ??= parseDurationLog(line, "model loaded in");
      promptEmbeddingMs ??= parseDurationLog(
        line,
        "prompt embeddings ready in",
      );
      if (line.includes("worker ready") && readyAt === null) {
        readyAt = Date.now();
        memory.readyWorkingSetBytes = latestWorkingSetBytes || null;
        requestSentAt = Date.now();
        child.stdin.write(
          `${JSON.stringify({
            type: "inpaint",
            id: "cpu-benchmark",
            input: inputPath,
            mask: maskPath,
            output: outputPath,
            steps,
            strength: 1,
            max_pixels: size * size,
            mask_padding: 16,
          })}\n`,
        );
      }
    }
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutLineBuffer += chunk;
    const lines = stdoutLineBuffer.split(/\r?\n/);
    stdoutLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!line.trimStart().startsWith("{")) {
        stdoutLogLines.push(line);
        process.stderr.write(`[runner stdout] ${line}\n`);
        continue;
      }
      response = /** @type {WorkerResponse} */ (JSON.parse(line));
      child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      child.stdin.end();
    }
  });

  const exit = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timeout);
  stopMemorySampler();

  if (timedOut) {
    throw new Error(`CPU benchmark exceeded ${timeoutMinutes} minutes`);
  }
  const completedResponse = /** @type {WorkerResponse | null} */ (response);
  if (
    !completedResponse ||
    completedResponse.ok !== true ||
    !existsSync(outputPath)
  ) {
    throw new Error(
      `CPU benchmark failed (exit=${JSON.stringify(exit)}): ${stderr.slice(-4000)}`,
    );
  }

  const completedAt = Date.now();
  return buildBenchmarkResult({
    completedAt,
    completedResponse,
    memory,
    modelLoadMs,
    promptEmbeddingMs,
    readyAt,
    requestSentAt,
    startedAt,
    stdoutLogLines,
  });
}

/**
 * @param {{
 *   completedAt: number;
 *   completedResponse: WorkerResponse;
 *   memory: MemoryMetrics;
 *   modelLoadMs: number | null;
 *   promptEmbeddingMs: number | null;
 *   readyAt: number | null;
 *   requestSentAt: number | null;
 *   startedAt: number;
 *   stdoutLogLines: string[];
 * }} state
 */
function buildBenchmarkResult(state) {
  const cpu = cpus()[0];
  return {
    schemaVersion: 1,
    runner: {
      path: runner,
      fileName: basename(runner),
      cpuOnlyBuild: capabilities.cpu_only,
      capabilities,
    },
    model: {
      transformer,
      vae,
    },
    workload: {
      width: size,
      height: size,
      steps,
      maxPixels: size * size,
      maskPadding: 16,
    },
    timing: {
      startupToReadyMs:
        state.readyAt === null ? null : state.readyAt - state.startedAt,
      modelLoadMs: state.modelLoadMs,
      promptEmbeddingMs: state.promptEmbeddingMs,
      pageRunnerElapsedMs: Number(state.completedResponse.elapsed_ms),
      pageWallMs:
        state.requestSentAt === null
          ? null
          : state.completedAt - state.requestSentAt,
      totalWallMs: state.completedAt - state.startedAt,
    },
    memory: state.memory,
    host: {
      scenario,
      platform: platform(),
      release: release(),
      cpu: cpu?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      expectedMemoryGb,
    },
    output: {
      path: outputPath,
      bytes: readFileSync(outputPath).byteLength,
      artifactsKept: keepArtifacts,
    },
    stdoutLogLines: state.stdoutLogLines,
  };
}

/**
 * @param {BenchmarkScenario} scenario
 * @param {number | null} expectedMemoryGb
 */
function assertHardwareScenario(scenario, expectedMemoryGb) {
  const nvidia = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name", "--format=csv,noheader"],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
  const hasNvidiaGpu =
    nvidia.status === 0 && String(nvidia.stdout || "").trim().length > 0;
  if (scenario === "cpu-only" && hasNvidiaGpu) {
    throw new Error(
      "--scenario cpu-only requires a machine with no NVIDIA GPU detected",
    );
  }
  if (scenario === "nvidia-cpu-selected" && !hasNvidiaGpu) {
    throw new Error(
      "--scenario nvidia-cpu-selected requires an NVIDIA GPU to be present",
    );
  }
  if (expectedMemoryGb !== null) {
    const actualMemoryGb = totalmem() / 1024 ** 3;
    const toleranceGb = Math.max(1.5, expectedMemoryGb * 0.08);
    if (Math.abs(actualMemoryGb - expectedMemoryGb) > toleranceGb) {
      throw new Error(
        `Expected approximately ${expectedMemoryGb} GiB RAM for this matrix row, detected ${actualMemoryGb.toFixed(1)} GiB`,
      );
    }
  }
}

/** @param {unknown} value @returns {BenchmarkScenario} */
function parseScenario(value) {
  const scenario = String(value).trim().toLowerCase();
  if (
    scenario === "unspecified" ||
    scenario === "cpu-only" ||
    scenario === "nvidia-cpu-selected"
  ) {
    return scenario;
  }
  throw new Error(
    "--scenario must be unspecified, cpu-only, or nvidia-cpu-selected",
  );
}

/** @param {string} path @returns {RunnerCapabilities} */
function readCpuRunnerCapabilities(path) {
  const result = spawnSync(path, ["--capabilities"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `CPU runner capability probe failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  const line = String(result.stdout || "")
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith("{"));
  const value = /** @type {RunnerCapabilities | null} */ (
    line ? JSON.parse(line) : null
  );
  if (
    value?.backend !== "cpu-native" ||
    value?.cpu_only !== true ||
    value?.cuda_compiled !== false ||
    value?.metal_compiled !== false
  ) {
    throw new Error(`Runner is not CPU-only: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * @param {number} pid
 * @param {(sample: MemorySample) => void} onSample
 * @returns {() => void}
 */
function startMemorySampler(pid, onSample) {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `while ($true) { $p = Get-Process -Id ${pid}; if ($null -eq $p) { break }; Write-Output ($p.WorkingSet64.ToString() + ',' + $p.PrivateMemorySize64.ToString()); Start-Sleep -Milliseconds 200 }`,
    ].join("; ");
    const sampler = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    sampler.stdout.setEncoding("utf8");
    let buffer = "";
    sampler.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const [workingSetBytes, privateBytes] = line.split(",").map(Number);
        if (Number.isFinite(workingSetBytes) && Number.isFinite(privateBytes)) {
          onSample({ workingSetBytes, privateBytes });
        }
      }
    });
    return () => sampler.kill();
  }

  const timer = setInterval(() => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const workingSetBytes = parseProcKb(status, "VmRSS") * 1024;
      const privateBytes = parseProcKb(status, "VmSize") * 1024;
      onSample({ workingSetBytes, privateBytes });
    } catch (_error) {
      clearInterval(timer);
    }
  }, 200);
  return () => clearInterval(timer);
}

/** @param {string} status @param {string} key @returns {number} */
function parseProcKb(status, key) {
  const match = status.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
  return match ? Number(match[1]) : 0;
}

/** @param {string} line @param {string} marker @returns {number | null} */
function parseDurationLog(line, marker) {
  const index = line.indexOf(marker);
  if (index < 0) return null;
  const value = line.slice(index + marker.length).trim();
  const match = /^(\d+(?:\.\d+)?)(ns|µs|us|ms|s)$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  return (
    amount * ({ ns: 1e-6, µs: 1e-3, us: 1e-3, ms: 1, s: 1000 }[match[2]] ?? 1)
  );
}

/** @param {string} inputPath @param {string} maskPath @param {number} size */
function writeBenchmarkImages(inputPath, maskPath, size) {
  const input = new PNG({ width: size, height: size });
  const mask = new PNG({ width: size, height: size });
  const maskStart = Math.floor(size * 0.28);
  const maskEnd = Math.ceil(size * 0.72);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const paper = 238 + ((x + y) % 17);
      const ink = x % Math.max(12, Math.floor(size / 9)) < 2 ? 35 : paper;
      input.data[offset] = ink;
      input.data[offset + 1] = ink;
      input.data[offset + 2] = ink;
      input.data[offset + 3] = 255;
      const selected =
        x >= maskStart && x < maskEnd && y >= maskStart && y < maskEnd;
      const maskValue = selected ? 255 : 0;
      mask.data[offset] = maskValue;
      mask.data[offset + 1] = maskValue;
      mask.data[offset + 2] = maskValue;
      mask.data[offset + 3] = 255;
    }
  }
  writeFileSync(inputPath, PNG.sync.write(input));
  writeFileSync(maskPath, PNG.sync.write(mask));
}

/** @param {unknown} value @param {string} flag @returns {string} */
function requireFile(value, flag) {
  if (!value) {
    throw new Error(`${flag} is required`);
  }
  const path = resolve(String(value));
  if (!existsSync(path)) {
    throw new Error(`${flag} does not exist: ${path}`);
  }
  return path;
}

/** @param {unknown} value @param {string} flag @returns {number} */
function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

/** @param {unknown} value @param {string} flag @returns {number} */
function parsePositiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return parsed;
}

/** @param {string[]} argv @returns {Record<string, string>} */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}
