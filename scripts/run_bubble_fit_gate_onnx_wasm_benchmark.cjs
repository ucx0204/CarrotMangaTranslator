#!/usr/bin/env node
"use strict";
/* eslint-disable max-lines -- standalone CLI, runtime pins, metadata checks, timing scopes, and report schema stay in one auditable subprocess contract */

/**
 * Standalone, inference-only benchmark for an exported bubble-fit gate ONNX
 * model. Launch this file directly with Electron's executable; it creates no
 * renderer window and has no production wiring.
 *
 * Example (Windows):
 * node_modules\\electron\\dist\\electron.exe scripts\\run_bubble_fit_gate_onnx_wasm_benchmark.cjs \
 *   --model C:\\exact\\final-candidate.onnx --warmup 2 --repeat 10 \
 *   --seed 1729 --batch 1 --output C:\\exact\\benchmark.json
 */

const { createHash } = require("node:crypto");
const {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { dirname, extname, join, resolve } = require("node:path");
const { performance: nodePerformance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");
const {
  BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS: RUNTIME_PINS,
} = require("./bubble_fit_gate_onnx_wasm_benchmark_pins.cjs");

const REPORT_SCHEMA = "bubble-fit-gate-onnx-wasm-benchmark-v2";
const INPUT_GENERATOR_CONTRACT = "xorshift32-f32-minus1-plus1-v1";
const EXPECTED_INPUT_NAME = "input";
const EXPECTED_OUTPUT_NAME = "safe_probability";
const INPUT_CHANNELS = 4;
const INPUT_HEIGHT = 224;
const INPUT_WIDTH = 224;
const MAX_BATCH = 64;
const MAX_ITERATIONS = 10_000;
const UINT32_RANGE = 0x1_0000_0000;

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message);
}

/** @param {import("node:crypto").BinaryLike} value */
function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} path */
function readRegularFile(path) {
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath)) {
    fail(`File does not exist: ${resolvedPath}`);
  }
  const realPath = realpathSync(resolvedPath);
  if (!statSync(realPath).isFile()) {
    fail(`Path is not a regular file: ${realPath}`);
  }
  const bytes = readFileSync(realPath);
  return {
    bytes,
    path: realPath,
    sha256: sha256Bytes(bytes),
    sizeBytes: bytes.byteLength,
  };
}

/**
 * @param {string} path
 * @param {{sha256:string;sizeBytes:number}} pin
 * @param {string} label
 */
function readPinnedRegularFile(path, pin, label) {
  const file = readRegularFile(path);
  if (file.sizeBytes !== pin.sizeBytes || file.sha256 !== pin.sha256) {
    fail(`${label} differs from the pinned SHA-256/byte contract`);
  }
  return file;
}

/** @param {unknown} value @param {string} location */
function requireNonEmptyText(value, location) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${location} requires a non-empty value`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} location
 * @param {number} minimum
 * @param {number} maximum
 */
function parseBoundedInteger(value, location, minimum, maximum) {
  const text = requireNonEmptyText(value, location);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    fail(`${location} must be an integer from ${minimum} through ${maximum}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${location} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

/** @param {unknown} value @param {string} location */
function parseProbability(value, location) {
  const text = requireNonEmptyText(value, location);
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    fail(`${location} must be a finite number in [0,1]`);
  }
  return parsed;
}

/** @param {unknown} value @param {string} location */
function parsePositiveTolerance(value, location) {
  const text = requireNonEmptyText(value, location);
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    fail(`${location} must be a finite number in (0,1]`);
  }
  return parsed;
}

/** @param {unknown} value @param {string} location */
function requireSha256(value, location) {
  const text = requireNonEmptyText(value, location).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(text)) {
    fail(`${location} must be a lowercase SHA-256 digest`);
  }
  return text;
}

/**
 * @param {string[]} argv
 * @returns {{batch:number;expectedParity:null|{inputSha256:string;probability:number;tolerance:number};model:string;output:string;repeat:number;seed:number;warmup:number}}
 */
function parseArguments(argv) {
  const known = new Set([
    "--batch",
    "--expected-input-sha256",
    "--expected-probability",
    "--model",
    "--output",
    "--probability-tolerance",
    "--repeat",
    "--seed",
    "--warmup",
  ]);
  /** @type {Map<string, string>} */
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!known.has(flag)) {
      fail(`Unknown argument: ${flag}`);
    }
    if (values.has(flag)) {
      fail(`Duplicate argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || known.has(value) || value.startsWith("--")) {
      fail(`${flag} requires a value`);
    }
    values.set(flag, value);
    index += 1;
  }
  for (const required of [
    "--model",
    "--output",
    "--repeat",
    "--seed",
    "--warmup",
  ]) {
    if (!values.has(required)) {
      fail(`Missing required argument: ${required}`);
    }
  }
  const batch = parseBoundedInteger(
    values.get("--batch") ?? "1",
    "--batch",
    1,
    MAX_BATCH,
  );
  const hasExpectedInput = values.has("--expected-input-sha256");
  const hasExpectedProbability = values.has("--expected-probability");
  if (hasExpectedInput !== hasExpectedProbability) {
    fail(
      "--expected-input-sha256 and --expected-probability must be supplied together",
    );
  }
  if (values.has("--probability-tolerance") && !hasExpectedProbability) {
    fail("--probability-tolerance requires an expected parity binding");
  }
  if (hasExpectedProbability && batch !== 1) {
    fail("Expected scalar probability binding requires --batch 1");
  }
  const expectedParity = hasExpectedProbability
    ? {
        inputSha256: requireSha256(
          values.get("--expected-input-sha256"),
          "--expected-input-sha256",
        ),
        probability: parseProbability(
          values.get("--expected-probability"),
          "--expected-probability",
        ),
        tolerance: parsePositiveTolerance(
          values.get("--probability-tolerance") ?? "0.00002",
          "--probability-tolerance",
        ),
      }
    : null;
  return {
    batch,
    expectedParity,
    model: requireNonEmptyText(values.get("--model"), "--model"),
    output: requireNonEmptyText(values.get("--output"), "--output"),
    repeat: parseBoundedInteger(
      values.get("--repeat"),
      "--repeat",
      1,
      MAX_ITERATIONS,
    ),
    seed: parseBoundedInteger(
      values.get("--seed"),
      "--seed",
      0,
      UINT32_RANGE - 1,
    ),
    warmup: parseBoundedInteger(
      values.get("--warmup"),
      "--warmup",
      0,
      MAX_ITERATIONS,
    ),
  };
}

/**
 * Electron's main-process bootstrap can include the application entry twice
 * in process.argv. Strip only exact copies of this dedicated entry path; every
 * other positional or unknown argument remains a hard error.
 * @param {string[]} argv
 */
function commandArguments(argv) {
  const values = argv.slice(1);
  const entryPath = resolve(__filename);
  while (values[0] !== undefined && resolve(values[0]) === entryPath) {
    values.shift();
  }
  return values;
}

/** @param {number} seed @param {number} elementCount */
function buildSeededInput(seed, elementCount) {
  const values = new Float32Array(elementCount);
  let state = seed >>> 0;
  for (let index = 0; index < values.length; index += 1) {
    state = (state ^ ((state << 13) >>> 0)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ ((state << 5) >>> 0)) >>> 0;
    values[index] = Math.fround((state / UINT32_RANGE) * 2 - 1);
  }
  return values;
}

/** @param {ArrayLike<number>} values @param {string} location */
function ensureFinite(values, location) {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) {
      fail(`${location} contains a non-finite value`);
    }
  }
}

/** @param {Float32Array} values */
function float32Bytes(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

/** @param {number[]} sorted @param {number} probability */
function nearestRankPercentile(sorted, probability) {
  const rank = Math.max(1, Math.ceil(probability * sorted.length));
  return sorted[rank - 1];
}

/** @param {number[]} samples */
function summarizeTimings(samples) {
  if (samples.length === 0) fail("No measured inference timings were recorded");
  ensureFinite(samples, "inference timings");
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    max: sorted[sorted.length - 1],
    mean: total / samples.length,
    min: sorted[0],
    p50: nearestRankPercentile(sorted, 0.5),
    p95: nearestRankPercentile(sorted, 0.95),
    percentileMethod: "nearest-rank",
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    arrayBuffers: memory.arrayBuffers,
    external: memory.external,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    rss: memory.rss,
  };
}

/**
 * @param {readonly import("onnxruntime-web").InferenceSession.ValueMetadata[]} metadata
 * @param {string} expectedName
 * @param {readonly (number|string)[]} expectedShape
 * @param {string} location
 */
function requireExactTensorMetadata(
  metadata,
  expectedName,
  expectedShape,
  location,
) {
  if (metadata.length !== 1) {
    fail(`${location} metadata must contain exactly one value`);
  }
  const value = metadata[0];
  if (
    value.name !== expectedName ||
    value.isTensor !== true ||
    value.type !== "float32" ||
    JSON.stringify(value.shape) !== JSON.stringify(expectedShape)
  ) {
    fail(
      `${location} metadata must be tensor float32 ${JSON.stringify(expectedShape)}`,
    );
  }
  return {
    isTensor: true,
    name: value.name,
    shape: [...value.shape],
    type: value.type,
  };
}

/** @param {import("onnxruntime-web").InferenceSession} session */
function requireExactSessionContract(session) {
  if (
    JSON.stringify(session.inputNames) !==
      JSON.stringify([EXPECTED_INPUT_NAME]) ||
    JSON.stringify(session.outputNames) !==
      JSON.stringify([EXPECTED_OUTPUT_NAME])
  ) {
    fail(
      `Model names must be ${EXPECTED_INPUT_NAME} -> ${EXPECTED_OUTPUT_NAME}`,
    );
  }
  return {
    input: requireExactTensorMetadata(
      session.inputMetadata,
      EXPECTED_INPUT_NAME,
      ["batch", INPUT_CHANNELS, INPUT_HEIGHT, INPUT_WIDTH],
      "input",
    ),
    output: requireExactTensorMetadata(
      session.outputMetadata,
      EXPECTED_OUTPUT_NAME,
      ["batch", 1],
      "output",
    ),
  };
}

/**
 * @param {import("onnxruntime-web").InferenceSession} session
 * @param {import("onnxruntime-web").InferenceSession.FeedsType} feeds
 * @param {number} batch
 */
async function runMeasuredInference(session, feeds, batch) {
  const wrapperStartedAt = nodePerformance.now();
  const sessionRunStartedAt = nodePerformance.now();
  const outputs = await session.run(feeds);
  const pureSessionRunMs = nodePerformance.now() - sessionRunStartedAt;
  const output = outputs[EXPECTED_OUTPUT_NAME];
  if (!output) fail(`Model did not emit ${EXPECTED_OUTPUT_NAME}`);
  /** @type {Float32Array | undefined} */
  let probabilities;
  try {
    if (
      output.type !== "float32" ||
      output.dims.length !== 2 ||
      output.dims[0] !== batch ||
      output.dims[1] !== 1
    ) {
      fail(`${EXPECTED_OUTPUT_NAME} must be float32 [batch,1]`);
    }
    probabilities = Float32Array.from(
      /** @type {ArrayLike<number>} */ (output.data),
    );
    ensureFinite(probabilities, EXPECTED_OUTPUT_NAME);
    for (const probability of probabilities) {
      if (probability < 0 || probability > 1) {
        fail(`${EXPECTED_OUTPUT_NAME} contains a value outside [0,1]`);
      }
    }
  } finally {
    output.dispose();
  }
  if (!probabilities) fail(`${EXPECTED_OUTPUT_NAME} was not copied`);
  return {
    probabilities,
    pureSessionRunMs,
    reusedInputTensorWrapperMs: nodePerformance.now() - wrapperStartedAt,
  };
}

function loadPinnedOrtRuntime() {
  const repositoryRoot = resolve(__dirname, "..");
  const ortRoot = join(repositoryRoot, "node_modules", "onnxruntime-web");
  const packageJson = JSON.parse(
    readFileSync(join(ortRoot, "package.json"), "utf8"),
  );
  if (
    packageJson.name !== RUNTIME_PINS.packageName ||
    packageJson.version !== RUNTIME_PINS.packageVersion
  ) {
    fail("onnxruntime-web package/version differs from the pinned contract");
  }
  const runtimeEntry = readPinnedRegularFile(
    join(ortRoot, "dist", RUNTIME_PINS.entry.file),
    RUNTIME_PINS.entry,
    "onnxruntime-web entry",
  );
  const wasmModule = readPinnedRegularFile(
    join(ortRoot, "dist", RUNTIME_PINS.wasmModule.file),
    RUNTIME_PINS.wasmModule,
    "onnxruntime-web WASM module",
  );
  const wasmBinary = readPinnedRegularFile(
    join(ortRoot, "dist", RUNTIME_PINS.wasmBinary.file),
    RUNTIME_PINS.wasmBinary,
    "onnxruntime-web WASM binary",
  );
  const ort = /** @type {typeof import("onnxruntime-web")} */ (
    require(runtimeEntry.path)
  );
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: pathToFileURL(wasmModule.path).href,
    wasm: pathToFileURL(wasmBinary.path).href,
  };
  return {
    ort,
    packageVersion: packageJson.version,
    runtimeEntry,
    wasmBinary,
    wasmModule,
  };
}

/**
 * @param {typeof import("onnxruntime-web")} ort
 * @param {Buffer} modelBytes
 * @param {Float32Array} input
 * @param {{batch:number;repeat:number;warmup:number}} options
 */
async function benchmarkSession(ort, modelBytes, input, options) {
  const sessionStartedAt = nodePerformance.now();
  const session = await ort.InferenceSession.create(
    new Uint8Array(
      modelBytes.buffer,
      modelBytes.byteOffset,
      modelBytes.byteLength,
    ),
    {
      executionMode: "sequential",
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    },
  );
  const sessionInitializationMs = nodePerformance.now() - sessionStartedAt;
  /** @type {Float32Array | null} */
  let measuredOutput = null;
  /** @type {string | null} */
  let measuredChecksum = null;
  /** @type {number[]} */
  const pureSessionRunTimings = [];
  /** @type {number[]} */
  const reusedInputTensorWrapperTimings = [];
  /** @type {ReturnType<typeof memorySnapshot> | undefined} */
  let memoryAfterInference;
  const modelInterface = requireExactSessionContract(session);
  const inputTensor = new ort.Tensor("float32", input, [
    options.batch,
    INPUT_CHANNELS,
    INPUT_HEIGHT,
    INPUT_WIDTH,
  ]);
  const feeds = { [EXPECTED_INPUT_NAME]: inputTensor };
  try {
    for (let index = 0; index < options.warmup; index += 1) {
      await runMeasuredInference(session, feeds, options.batch);
    }
    for (let index = 0; index < options.repeat; index += 1) {
      const measured = await runMeasuredInference(
        session,
        feeds,
        options.batch,
      );
      pureSessionRunTimings.push(measured.pureSessionRunMs);
      reusedInputTensorWrapperTimings.push(measured.reusedInputTensorWrapperMs);
      const checksum = sha256Bytes(float32Bytes(measured.probabilities));
      if (measuredChecksum !== null && checksum !== measuredChecksum) {
        fail("Repeated inference output checksum changed");
      }
      measuredOutput = measured.probabilities;
      measuredChecksum = checksum;
    }
    memoryAfterInference = memorySnapshot();
  } finally {
    inputTensor.dispose();
    await session.release();
  }
  if (!measuredOutput || !measuredChecksum || !memoryAfterInference) {
    fail("Benchmark emitted no measured output");
  }
  return {
    measuredChecksum,
    measuredOutput,
    memoryAfterInference,
    modelInterface,
    pureSessionRunTimings,
    reusedInputTensorWrapperTimings,
    sessionInitializationMs,
  };
}

async function main() {
  const args = parseArguments(commandArguments(process.argv));
  if (!process.versions.electron) {
    fail("Launch this benchmark with the pinned Electron executable");
  }
  if (extname(args.model).toLowerCase() !== ".onnx") {
    fail("--model must identify an ONNX file");
  }
  if (extname(args.output).toLowerCase() !== ".json") {
    fail("--output must identify a JSON file");
  }
  const outputPath = resolve(args.output);
  if (existsSync(outputPath)) {
    fail(`Refusing to overwrite output: ${outputPath}`);
  }
  if (!existsSync(dirname(outputPath))) {
    fail(`Output directory does not exist: ${dirname(outputPath)}`);
  }

  const memoryBefore = memorySnapshot();
  const model = readRegularFile(args.model);
  if (resolve(model.path) === outputPath) {
    fail("--output must differ from --model");
  }

  const runtime = loadPinnedOrtRuntime();
  const { ort } = runtime;

  const inputShape = [args.batch, INPUT_CHANNELS, INPUT_HEIGHT, INPUT_WIDTH];
  const input = buildSeededInput(
    args.seed,
    inputShape.reduce((total, dimension) => total * dimension, 1),
  );
  const inputChecksum = sha256Bytes(float32Bytes(input));
  if (
    args.expectedParity &&
    inputChecksum !== args.expectedParity.inputSha256
  ) {
    fail("Generated input SHA-256 differs from the expected parity binding");
  }
  const benchmark = await benchmarkSession(ort, model.bytes, input, args);
  const parityBinding = args.expectedParity
    ? {
        absoluteError: Math.abs(
          benchmark.measuredOutput[0] - args.expectedParity.probability,
        ),
        expectedInputSha256: args.expectedParity.inputSha256,
        expectedProbability: args.expectedParity.probability,
        passed: true,
        tolerance: args.expectedParity.tolerance,
      }
    : null;
  if (parityBinding && parityBinding.absoluteError > parityBinding.tolerance) {
    fail("Output probability differs from the expected parity binding");
  }
  const memoryAfter = memorySnapshot();
  const report = {
    schemaVersion: REPORT_SCHEMA,
    artifactKind: "standalone-onnxruntime-web-wasm-benchmark",
    inferenceOnly: true,
    preprocessorCovered: false,
    productionEligible: false,
    productionUseForbidden: true,
    productionWiringPresent: false,
    threshold: null,
    decisionProduced: false,
    model: {
      interfaceMetadata: benchmark.modelInterface,
      path: model.path,
      sha256: model.sha256,
      sizeBytes: model.sizeBytes,
    },
    runtime: {
      host: "electron-main",
      executionProvider: "wasm",
      executionMode: "sequential",
      graphOptimizationLevel: "all",
      wasmNumThreads: ort.env.wasm.numThreads,
      versions: {
        chrome: process.versions.chrome ?? null,
        electron: process.versions.electron,
        node: process.versions.node,
        onnxruntimeWeb: runtime.packageVersion,
        v8: process.versions.v8,
      },
      assets: {
        entry: {
          file: RUNTIME_PINS.entry.file,
          path: runtime.runtimeEntry.path,
          sha256: runtime.runtimeEntry.sha256,
          sizeBytes: runtime.runtimeEntry.sizeBytes,
        },
        wasmModule: {
          file: RUNTIME_PINS.wasmModule.file,
          path: runtime.wasmModule.path,
          sha256: runtime.wasmModule.sha256,
          sizeBytes: runtime.wasmModule.sizeBytes,
        },
        wasmBinary: {
          file: RUNTIME_PINS.wasmBinary.file,
          path: runtime.wasmBinary.path,
          sha256: runtime.wasmBinary.sha256,
          sizeBytes: runtime.wasmBinary.sizeBytes,
        },
      },
    },
    input: {
      dtype: "float32",
      generatorContract: INPUT_GENERATOR_CONTRACT,
      name: EXPECTED_INPUT_NAME,
      seed: args.seed,
      sha256: inputChecksum,
      shape: inputShape,
    },
    output: {
      dtype: "float32",
      name: EXPECTED_OUTPUT_NAME,
      probability: benchmark.measuredOutput[0],
      probabilities: Array.from(benchmark.measuredOutput),
      repeatedOutputStable: true,
      sha256: benchmark.measuredChecksum,
      shape: [args.batch, 1],
      semantics: "sigmoid_safe_probability",
    },
    expectedParityBinding: parityBinding,
    benchmark: {
      latencyDefinitions: {
        pureSessionRunMs:
          "Only await session.run(feeds), with one pre-created input tensor reused; excludes output lookup, validation, copy, checksum, and disposal.",
        reusedInputTensorWrapperMs:
          "session.run plus output lookup, shape/value validation, float32 copy, and output disposal; excludes input tensor creation and diagnostic SHA-256.",
      },
      pureSessionRunMs: summarizeTimings(benchmark.pureSessionRunTimings),
      repeat: args.repeat,
      reusedInputTensorWrapperMs: summarizeTimings(
        benchmark.reusedInputTensorWrapperTimings,
      ),
      sessionInitializationMs: benchmark.sessionInitializationMs,
      warmup: args.warmup,
    },
    coarseProcessMemorySnapshots: {
      interpretation:
        "Point-in-time process.memoryUsage() snapshots for the Electron main process. They include Electron/Node/V8, ORT JavaScript and WASM runtime state, model/input/output buffers, allocator behavior, and unrelated process overhead.",
      modelFootprintIsolated: false,
      peakMemoryMeasured: false,
      leakMeasurement: false,
      retentionCaveat:
        "The model Buffer, deterministic input Float32Array, and loaded ORT/WASM runtime remain referenced after session release; garbage collection is not forced, so deltas are neither model footprint nor retained-leak evidence.",
      snapshots: {
        afterMeasuredInferenceBeforeRelease: benchmark.memoryAfterInference,
        afterSessionAndInputTensorRelease: memoryAfter,
        beforeModelAndRuntimeLoad: memoryBefore,
      },
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

// Electron loads its entry through an internal bootstrap, so require.main is
// not a reliable direct-entry signal. This dedicated subprocess always runs.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
