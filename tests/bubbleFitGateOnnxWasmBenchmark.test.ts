import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ONNXRUNTIME_WEB_VERSION,
  ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
  ONNXRUNTIME_WEB_WASM_BINARY_FILE,
  ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  ONNXRUNTIME_WEB_WASM_MODULE_BYTES,
  ONNXRUNTIME_WEB_WASM_MODULE_FILE,
  ONNXRUNTIME_WEB_WASM_MODULE_SHA256,
} from "../src/main/bubbleLayout/constants";

const { ensureElectronExecutable } =
  require("../scripts/electron-executable.cjs") as {
    ensureElectronExecutable: (root: string) => string;
  };
const { BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS } =
  require("../scripts/bubble_fit_gate_onnx_wasm_benchmark_pins.cjs") as {
    BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS: {
      packageName: string;
      packageVersion: string;
      entry: { file: string; sha256: string; sizeBytes: number };
      wasmModule: { file: string; sha256: string; sizeBytes: number };
      wasmBinary: { file: string; sha256: string; sizeBytes: number };
    };
  };

const REPOSITORY_ROOT = join(__dirname, "..");
const BENCHMARK_ENTRY = join(
  REPOSITORY_ROOT,
  "scripts",
  "run_bubble_fit_gate_onnx_wasm_benchmark.cjs",
);
const ACTUAL_MODEL_ROOT = join(
  REPOSITORY_ROOT,
  "artifacts",
  "bubble-fit-gate-candidate-linear-binary-e8-seed1729-v1",
);
const ACTUAL_MODEL = join(ACTUAL_MODEL_ROOT, "final-candidate.onnx");
const ACTUAL_CONTRACT = join(
  ACTUAL_MODEL_ROOT,
  "final-candidate-contract.json",
);
const TINY_GATE_ONNX_BASE64 =
  "CAgSHW1hbmdhLXRyYW5zbGF0b3ItdGVzdC1maXh0dXJlOocCCj0KBWlucHV0EgZtZWFuNGQiClJlZHVjZU1lYW4qDwoEYXhlc0ABQAJAA6ABByoPCghrZWVwZGltcxgBoAECCiAKBm1lYW40ZAoFc2hhcGUSBm1lYW4yZCIHUmVzaGFwZQojCgZtZWFuMmQSEHNhZmVfcHJvYmFiaWxpdHkiB1NpZ21vaWQSFHRpbnktYnViYmxlLWZpdC1nYXRlKhgIAhAHOgv///////////8BAUIFc2hhcGVaJgoFaW5wdXQSHQobCAESFwoHEgViYXRjaAoCCAQKAwjgAQoDCOABYicKEHNhZmVfcHJvYmFiaWxpdHkSEwoRCAESDQoHEgViYXRjaAoCCAFCBAoAEBE=";
const MALFORMED_THREE_CHANNEL_GATE_ONNX_BASE64 =
  "CAgSHW1hbmdhLXRyYW5zbGF0b3ItdGVzdC1maXh0dXJlOokCCj0KBWlucHV0EgZtZWFuNGQiClJlZHVjZU1lYW4qDwoEYXhlc0ABQAJAA6ABByoPCghrZWVwZGltcxgBoAECCiAKBm1lYW40ZAoFc2hhcGUSBm1lYW4yZCIHUmVzaGFwZQojCgZtZWFuMmQSEHNhZmVfcHJvYmFiaWxpdHkiB1NpZ21vaWQSFmJhZC10aHJlZS1jaGFubmVsLWdhdGUqGAgCEAc6C////////////wEBQgVzaGFwZVomCgVpbnB1dBIdChsIARIXCgcSBWJhdGNoCgIIAwoDCOABCgMI4AFiJwoQc2FmZV9wcm9iYWJpbGl0eRITChEIARINCgcSBWJhdGNoCgIIAUIECgAQEQ==";
const temporaryRoots: string[] = [];

const pythonOrtProbe = spawnSync(
  "python",
  ["-c", "import numpy, onnxruntime"],
  {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  },
);
const actualArtifactAvailable =
  existsSync(ACTUAL_MODEL) && existsSync(ACTUAL_CONTRACT);
if (!actualArtifactAvailable) {
  console.warn(
    `[bubble-fit-gate-wasm] actual-model parity skipped explicitly: missing ${ACTUAL_MODEL} or its contract`,
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("bubble-fit gate ORT-Web WASM benchmark", () => {
  it("keeps benchmark WASM pins equal to production constants", () => {
    expect(BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS).toMatchObject({
      packageName: "onnxruntime-web",
      packageVersion: ONNXRUNTIME_WEB_VERSION,
      entry: {
        file: "ort.node.min.js",
        sha256:
          "e83abc8b43ce2e160d3fe1a84ac7cdb674e7c3713e84545da1ba27baaf56db4a",
        sizeBytes: 27_103,
      },
      wasmModule: {
        file: ONNXRUNTIME_WEB_WASM_MODULE_FILE,
        sha256: ONNXRUNTIME_WEB_WASM_MODULE_SHA256,
        sizeBytes: ONNXRUNTIME_WEB_WASM_MODULE_BYTES,
      },
      wasmBinary: {
        file: ONNXRUNTIME_WEB_WASM_BINARY_FILE,
        sha256: ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
        sizeBytes: ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
      },
    });
  });

  it("runs a tiny dynamic 4-channel gate with the pinned one-thread contract", () => {
    const root = makeTemporaryRoot();
    const modelPath = join(root, "tiny-gate.onnx");
    const outputPath = join(root, "benchmark.json");
    const modelBytes = Buffer.from(TINY_GATE_ONNX_BASE64, "base64");
    writeFileSync(modelPath, modelBytes);

    const result = runBenchmark([
      "--model",
      modelPath,
      "--warmup",
      "1",
      "--repeat",
      "3",
      "--seed",
      "1729",
      "--batch",
      "2",
      "--output",
      outputPath,
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(report).toMatchObject({
      schemaVersion: "bubble-fit-gate-onnx-wasm-benchmark-v2",
      artifactKind: "standalone-onnxruntime-web-wasm-benchmark",
      inferenceOnly: true,
      preprocessorCovered: false,
      productionEligible: false,
      productionUseForbidden: true,
      productionWiringPresent: false,
      threshold: null,
      decisionProduced: false,
      model: {
        interfaceMetadata: {
          input: {
            isTensor: true,
            name: "input",
            shape: ["batch", 4, 224, 224],
            type: "float32",
          },
          output: {
            isTensor: true,
            name: "safe_probability",
            shape: ["batch", 1],
            type: "float32",
          },
        },
        sha256: createHash("sha256").update(modelBytes).digest("hex"),
        sizeBytes: modelBytes.byteLength,
      },
      runtime: {
        host: "electron-main",
        executionProvider: "wasm",
        executionMode: "sequential",
        graphOptimizationLevel: "all",
        wasmNumThreads: 1,
        versions: { onnxruntimeWeb: "1.27.0" },
        assets: {
          entry: BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS.entry,
          wasmModule: BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS.wasmModule,
          wasmBinary: BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS.wasmBinary,
        },
      },
      input: {
        dtype: "float32",
        generatorContract: "xorshift32-f32-minus1-plus1-v1",
        name: "input",
        seed: 1729,
        shape: [2, 4, 224, 224],
      },
      output: {
        dtype: "float32",
        name: "safe_probability",
        repeatedOutputStable: true,
        shape: [2, 1],
        semantics: "sigmoid_safe_probability",
      },
      expectedParityBinding: null,
      benchmark: { repeat: 3, warmup: 1 },
    });
    expect(report.runtime.versions.electron).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(report.runtime.versions.node).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(report.benchmark.sessionInitializationMs).toBeGreaterThan(0);
    for (const metric of ["pureSessionRunMs", "reusedInputTensorWrapperMs"]) {
      expect(report.benchmark[metric]).toMatchObject({
        count: 3,
        percentileMethod: "nearest-rank",
      });
      for (const key of ["min", "max", "mean", "p50", "p95"]) {
        expect(report.benchmark[metric][key]).toBeGreaterThanOrEqual(0);
      }
    }
    expect(
      report.benchmark.reusedInputTensorWrapperMs.mean,
    ).toBeGreaterThanOrEqual(report.benchmark.pureSessionRunMs.mean);
    expect(report.benchmark.latencyDefinitions.pureSessionRunMs).toContain(
      "Only await session.run",
    );
    expect(
      report.benchmark.latencyDefinitions.reusedInputTensorWrapperMs,
    ).toContain("excludes input tensor creation");
    expect(report.output.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.input.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const expectedProbabilities = fixtureProbabilities(1729, 2);
    expect(report.output.probabilities).toHaveLength(2);
    for (let index = 0; index < expectedProbabilities.length; index += 1) {
      expect(
        Math.abs(
          report.output.probabilities[index] - expectedProbabilities[index],
        ),
      ).toBeLessThanOrEqual(2e-5);
    }
    expect(report.coarseProcessMemorySnapshots).toMatchObject({
      modelFootprintIsolated: false,
      peakMemoryMeasured: false,
      leakMeasurement: false,
    });
    for (const phase of [
      "beforeModelAndRuntimeLoad",
      "afterMeasuredInferenceBeforeRelease",
      "afterSessionAndInputTensorRelease",
    ]) {
      expect(
        report.coarseProcessMemorySnapshots.snapshots[phase].rss,
      ).toBeGreaterThan(0);
      expect(
        report.coarseProcessMemorySnapshots.snapshots[phase].heapUsed,
      ).toBeGreaterThan(0);
    }
  }, 60_000);

  it("rejects a model whose declared input metadata has three channels", () => {
    const root = makeTemporaryRoot();
    const modelPath = join(root, "bad-three-channel-gate.onnx");
    const outputPath = join(root, "benchmark.json");
    writeFileSync(
      modelPath,
      Buffer.from(MALFORMED_THREE_CHANNEL_GATE_ONNX_BASE64, "base64"),
    );
    const result = runBenchmark([
      "--model",
      modelPath,
      "--warmup",
      "0",
      "--repeat",
      "1",
      "--seed",
      "1729",
      "--output",
      outputPath,
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "input metadata must be tensor float32",
    );
    expect(existsSync(outputPath)).toBe(false);
  }, 60_000);

  it("rejects a mismatched expected deterministic input binding", () => {
    const root = makeTemporaryRoot();
    const modelPath = join(root, "tiny-gate.onnx");
    const outputPath = join(root, "benchmark.json");
    writeFileSync(modelPath, Buffer.from(TINY_GATE_ONNX_BASE64, "base64"));
    const result = runBenchmark([
      "--model",
      modelPath,
      "--warmup",
      "0",
      "--repeat",
      "1",
      "--seed",
      "1729",
      "--expected-input-sha256",
      "0".repeat(64),
      "--expected-probability",
      "0.5",
      "--output",
      outputPath,
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Generated input SHA-256 differs from the expected parity binding",
    );
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    {
      name: "unknown arguments",
      args: ["--unknown", "value"],
      message: "Unknown argument: --unknown",
    },
    {
      name: "duplicate arguments",
      args: ["--model", "first.onnx", "--model", "second.onnx"],
      message: "Duplicate argument: --model",
    },
  ])("fails closed on $name", ({ args, message }) => {
    const result = runBenchmark(args);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
  });

  it.skipIf(!actualArtifactAvailable)(
    "matches the exported linear-binary gate against Python ORT CPU",
    () => {
      expect(
        pythonOrtProbe.status,
        `Actual artifact is present, so Python ORT is required.\n${pythonOrtProbe.stderr}`,
      ).toBe(0);
      const root = makeTemporaryRoot();
      const outputPath = join(root, "actual-model-benchmark.json");
      const seed = 1729;
      const batch = 1;
      const pythonResult = runPythonParity(ACTUAL_MODEL, seed, batch);
      const result = runBenchmark(
        [
          "--model",
          ACTUAL_MODEL,
          "--warmup",
          "1",
          "--repeat",
          "3",
          "--seed",
          String(seed),
          "--batch",
          String(batch),
          "--expected-input-sha256",
          pythonResult.inputSha256,
          "--expected-probability",
          String(pythonResult.probabilities[0]),
          "--probability-tolerance",
          "0.00002",
          "--output",
          outputPath,
        ],
        120_000,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(outputPath, "utf8"));
      const contract = JSON.parse(readFileSync(ACTUAL_CONTRACT, "utf8"));
      expect(report.model).toMatchObject({
        sha256: contract.onnx.sha256,
        sizeBytes: contract.onnx.sizeBytes,
      });
      expect(report).toMatchObject({
        inferenceOnly: true,
        preprocessorCovered: false,
        productionEligible: false,
        threshold: null,
        input: { shape: [batch, 4, 224, 224] },
        output: {
          name: "safe_probability",
          shape: [batch, 1],
          semantics: "sigmoid_safe_probability",
        },
        expectedParityBinding: {
          expectedInputSha256: pythonResult.inputSha256,
          expectedProbability: pythonResult.probabilities[0],
          passed: true,
          tolerance: 0.00002,
        },
      });

      expect(pythonResult.inputSha256).toBe(report.input.sha256);
      expect(pythonResult.inputName).toBe("input");
      expect(pythonResult.outputName).toBe("safe_probability");
      expect(pythonResult.outputShape).toEqual([batch, 1]);
      expect(pythonResult.probabilities).toHaveLength(batch);
      const absoluteErrors = pythonResult.probabilities.map(
        (probability: number, index: number) =>
          Math.abs(probability - report.output.probabilities[index]),
      );
      expect(Math.max(...absoluteErrors)).toBeLessThanOrEqual(2e-5);
      expect(report.expectedParityBinding.absoluteError).toBeLessThanOrEqual(
        2e-5,
      );
    },
    150_000,
  );
});

function makeTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "mgt-bubble-gate-wasm-"));
  temporaryRoots.push(root);
  return root;
}

function runBenchmark(args: string[], timeout = 30_000) {
  const electron = ensureElectronExecutable(REPOSITORY_ROOT);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawnSync(electron, [BENCHMARK_ENTRY, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    windowsHide: true,
  });
}

function seededInput(seed: number, elementCount: number) {
  const values = new Float32Array(elementCount);
  let state = seed >>> 0;
  for (let index = 0; index < values.length; index += 1) {
    state = (state ^ ((state << 13) >>> 0)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ ((state << 5) >>> 0)) >>> 0;
    values[index] = Math.fround((state / 0x1_0000_0000) * 2 - 1);
  }
  return values;
}

function fixtureProbabilities(seed: number, batch: number) {
  const rowSize = 4 * 224 * 224;
  const input = seededInput(seed, batch * rowSize);
  return Array.from({ length: batch }, (_, batchIndex) => {
    let total = 0;
    const start = batchIndex * rowSize;
    for (let index = start; index < start + rowSize; index += 1) {
      total += input[index];
    }
    return 1 / (1 + Math.exp(-(total / rowSize)));
  });
}

function runPythonParity(modelPath: string, seed: number, batch: number) {
  const script = String.raw`
import hashlib
import json
import sys

import numpy as np
import onnxruntime as ort

model_path = sys.argv[1]
seed = int(sys.argv[2])
batch = int(sys.argv[3])
count = batch * 4 * 224 * 224
values = np.empty(count, dtype=np.float32)
state = seed & 0xFFFFFFFF
for index in range(count):
    state = (state ^ ((state << 13) & 0xFFFFFFFF)) & 0xFFFFFFFF
    state = (state ^ (state >> 17)) & 0xFFFFFFFF
    state = (state ^ ((state << 5) & 0xFFFFFFFF)) & 0xFFFFFFFF
    values[index] = np.float32((state / 4294967296.0) * 2.0 - 1.0)
inputs = values.reshape((batch, 4, 224, 224))
options = ort.SessionOptions()
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
options.inter_op_num_threads = 1
options.intra_op_num_threads = 1
session = ort.InferenceSession(
    model_path,
    sess_options=options,
    providers=["CPUExecutionProvider"],
)
output = np.asarray(
    session.run(["safe_probability"], {"input": inputs})[0],
    dtype=np.float32,
)
print(json.dumps({
    "inputName": session.get_inputs()[0].name,
    "inputSha256": hashlib.sha256(values.tobytes()).hexdigest(),
    "ortVersion": ort.__version__,
    "outputName": session.get_outputs()[0].name,
    "outputShape": list(output.shape),
    "probabilities": output.reshape(-1).astype(float).tolist(),
}))
`;
  const result = spawnSync(
    "python",
    ["-c", script, modelPath, String(seed), String(batch)],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
