#!/usr/bin/env node
"use strict";

/**
 * Execute sealed Font Matching parity inputs with the app's actual
 * onnxruntime-web WASM backend. This file is launched as an Electron main
 * process by export_font_matching_runtime_onnx.py; it creates no window and
 * performs no network access.
 */

const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} = require("node:fs");
const { dirname, isAbsolute, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const REQUEST_SCHEMA = "font-matching-onnx-wasm-parity-request-v1";
const RESPONSE_SCHEMA = "font-matching-onnx-wasm-parity-response-v1";
const EXPECTED_PACKAGE = "onnxruntime-web";
const EXPECTED_VERSION = "1.27.0";

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message);
}

/** @param {import("node:crypto").BinaryLike} value */
function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} path */
function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

/**
 * @param {unknown} value
 * @param {string} location
 * @returns {Record<string, unknown>}
 */
function requireObject(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${location}: expected an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} location @returns {string} */
function requireText(value, location) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${location}: expected non-empty text`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} location
 * @param {number} [minimum]
 * @returns {number}
 */
function requireInteger(value, location, minimum = 1) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail(`${location}: expected integer >= ${minimum}`);
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} location
 * @returns {number[]}
 */
function requireShape(value, location) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${location}: expected a non-empty shape`);
  }
  return value.map((dimension, index) =>
    requireInteger(dimension, `${location}[${index}]`),
  );
}

/** @param {readonly number[]} shape */
function elementCount(shape) {
  return shape.reduce((total, dimension) => total * dimension, 1);
}

/**
 * @param {string} root
 * @param {unknown} descriptor
 * @param {string} location
 * @param {boolean} [allowExternal]
 */
function resolveRegularFile(root, descriptor, location, allowExternal = false) {
  const row = requireObject(descriptor, location);
  const relativePath = requireText(row.file, `${location}.file`);
  if (
    (!allowExternal && isAbsolute(relativePath)) ||
    (!allowExternal && relativePath.split(/[\\/]/u).includes(".."))
  ) {
    fail(`${location}.file must be request-relative`);
  }
  const path = isAbsolute(relativePath)
    ? resolve(relativePath)
    : resolve(root, relativePath);
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const rootPrefix = realRoot.endsWith(require("node:path").sep)
    ? realRoot
    : `${realRoot}${require("node:path").sep}`;
  if (
    (!allowExternal && !realPath.startsWith(rootPrefix)) ||
    !existsSync(realPath)
  ) {
    fail(`${location}.file escapes the request root or is missing`);
  }
  const digest = sha256File(realPath);
  if (digest !== requireText(row.sha256, `${location}.sha256`)) {
    fail(`${location}: SHA-256 mismatch`);
  }
  return realPath;
}

/**
 * @param {string} root
 * @param {unknown} descriptor
 * @param {string} location
 */
function readFloat32(root, descriptor, location) {
  const row = requireObject(descriptor, location);
  const path = resolveRegularFile(root, row, location);
  const shape = requireShape(row.shape, `${location}.shape`);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== elementCount(shape) * 4) {
    fail(`${location}: float32 byte size does not match shape`);
  }
  const copied = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const values = new Float32Array(copied);
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) {
      fail(`${location}: input contains a non-finite value`);
    }
  }
  return { path, shape, values };
}

/** @param {number} sampleCount @param {number} preferredBatchSize */
function batchSlices(sampleCount, preferredBatchSize) {
  if (sampleCount < 2) {
    fail("parity requires at least two rows to prove dynamic batching");
  }
  const slices = [[0, 1]];
  let start = 1;
  while (start < sampleCount) {
    const end = Math.min(sampleCount, start + preferredBatchSize);
    slices.push([start, end]);
    start = end;
  }
  if (!slices.some(([startIndex, endIndex]) => endIndex - startIndex > 1)) {
    fail("parity partition did not exercise a second batch size");
  }
  return slices;
}

/**
 * @param {Float32Array} values
 * @param {number} rowSize
 * @param {number} start
 * @param {number} end
 */
function sliceRows(values, rowSize, start, end) {
  return values.slice(start * rowSize, end * rowSize);
}

/** @param {ArrayLike<number>} values @param {string} location */
function ensureFinite(values, location) {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) {
      fail(`${location}: runtime output contains a non-finite value`);
    }
  }
}

/**
 * @param {string} outputRoot
 * @param {string} name
 * @param {Float32Array} values
 * @param {readonly number[]} shape
 */
function writeFloatOutput(outputRoot, name, values, shape) {
  ensureFinite(values, name);
  const file = `${name}.f32`;
  const path = join(outputRoot, file);
  const bytes = Buffer.from(
    values.buffer,
    values.byteOffset,
    values.byteLength,
  );
  writeFileSync(path, bytes);
  return {
    file,
    sha256: sha256File(path),
    shape,
  };
}

/**
 * @param {typeof import("onnxruntime-web")} ort
 * @param {string} requestRoot
 * @param {string} outputRoot
 * @param {unknown} config
 */
async function runEncoder(ort, requestRoot, outputRoot, config) {
  const row = requireObject(config, "encoder");
  const modelPath = resolveRegularFile(requestRoot, row.model, "encoder.model");
  const input = readFloat32(requestRoot, row.input, "encoder.input");
  if (
    input.shape.length !== 4 ||
    input.shape[1] !== 3 ||
    input.shape[2] !== 224 ||
    input.shape[3] !== 224
  ) {
    fail("encoder.input must have shape [N,3,224,224]");
  }
  const batchSize = requireInteger(row.batch_size, "encoder.batch_size");
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  try {
    if (
      session.inputNames.length !== 1 ||
      session.inputNames[0] !== "pixel_values" ||
      session.outputNames.length !== 1 ||
      session.outputNames[0] !== "image_features"
    ) {
      fail("encoder ONNX names differ from the production contract");
    }
    const rowSize = 3 * 224 * 224;
    /** @type {Float32Array[]} */
    const chunks = [];
    /** @type {number | null} */
    let featureDim = null;
    const slices = batchSlices(input.shape[0], batchSize);
    for (const [start, end] of slices) {
      const batch = sliceRows(input.values, rowSize, start, end);
      const outputs = await session.run({
        pixel_values: new ort.Tensor("float32", batch, [
          end - start,
          3,
          224,
          224,
        ]),
      });
      const tensor = outputs.image_features;
      if (
        !tensor ||
        tensor.dims.length !== 2 ||
        tensor.dims[0] !== end - start
      ) {
        fail("encoder emitted an invalid image_features tensor");
      }
      if (featureDim === null) {
        featureDim = tensor.dims[1];
      } else if (featureDim !== tensor.dims[1]) {
        fail("encoder feature dimension changed between dynamic batches");
      }
      ensureFinite(
        /** @type {ArrayLike<number>} */ (tensor.data),
        "encoder.image_features",
      );
      chunks.push(
        Float32Array.from(/** @type {ArrayLike<number>} */ (tensor.data)),
      );
    }
    if (featureDim === null) fail("encoder emitted no feature rows");
    const merged = new Float32Array(input.shape[0] * featureDim);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      dynamic_batch_sizes: [
        ...new Set(slices.map(([start, end]) => end - start)),
      ],
      input_names: [...session.inputNames],
      output_names: [...session.outputNames],
      outputs: {
        image_features: writeFloatOutput(
          outputRoot,
          "encoder-image_features",
          merged,
          [input.shape[0], featureDim],
        ),
      },
    };
  } finally {
    await session.release();
  }
}

/**
 * @param {typeof import("onnxruntime-web")} ort
 * @param {string} requestRoot
 * @param {string} outputRoot
 * @param {unknown} config
 */
async function runRanker(ort, requestRoot, outputRoot, config) {
  const row = requireObject(config, "ranker");
  const modelPath = resolveRegularFile(requestRoot, row.model, "ranker.model");
  const views = readFloat32(requestRoot, row.views, "ranker.views");
  const prototypes = readFloat32(
    requestRoot,
    row.prototype_features,
    "ranker.prototype_features",
  );
  if (
    views.shape.length !== 3 ||
    views.shape[1] !== 3 ||
    prototypes.shape.length !== 2 ||
    views.shape[2] !== prototypes.shape[1]
  ) {
    fail("ranker inputs have incompatible shapes");
  }
  if (!Array.isArray(row.output_names) || row.output_names.length === 0) {
    fail("ranker.output_names must be a non-empty array");
  }
  const outputNames = row.output_names.map((value, index) =>
    requireText(value, `ranker.output_names[${index}]`),
  );
  const batchSize = requireInteger(row.batch_size, "ranker.batch_size");
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  try {
    if (
      JSON.stringify(session.inputNames) !==
        JSON.stringify(["views", "prototype_features"]) ||
      JSON.stringify(session.outputNames) !== JSON.stringify(outputNames)
    ) {
      fail("ranker ONNX names differ from the production contract");
    }
    const rowSize = 3 * views.shape[2];
    const slices = batchSlices(views.shape[0], batchSize);
    /** @type {Record<string, Float32Array[]>} */
    const chunks = Object.fromEntries(outputNames.map((name) => [name, []]));
    /** @type {Record<string, number[]>} */
    const trailingShapes = {};
    const prototypeTensor = new ort.Tensor(
      "float32",
      prototypes.values,
      prototypes.shape,
    );
    for (const [start, end] of slices) {
      const outputs = await session.run({
        views: new ort.Tensor(
          "float32",
          sliceRows(views.values, rowSize, start, end),
          [end - start, 3, views.shape[2]],
        ),
        prototype_features: prototypeTensor,
      });
      for (const name of outputNames) {
        const tensor = outputs[name];
        if (!tensor || tensor.dims[0] !== end - start) {
          fail(`ranker emitted an invalid ${name} tensor`);
        }
        const trailing = tensor.dims.slice(1);
        if (trailingShapes[name] === undefined) {
          trailingShapes[name] = trailing;
        } else if (
          JSON.stringify(trailingShapes[name]) !== JSON.stringify(trailing)
        ) {
          fail(`ranker ${name} shape changed between dynamic batches`);
        }
        ensureFinite(
          /** @type {ArrayLike<number>} */ (tensor.data),
          `ranker.${name}`,
        );
        chunks[name].push(
          Float32Array.from(/** @type {ArrayLike<number>} */ (tensor.data)),
        );
      }
    }
    /** @type {Record<string, ReturnType<typeof writeFloatOutput>>} */
    const outputs = {};
    for (const name of outputNames) {
      const rowWidth = elementCount(trailingShapes[name]);
      const merged = new Float32Array(views.shape[0] * rowWidth);
      let offset = 0;
      for (const chunk of chunks[name]) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      outputs[name] = writeFloatOutput(outputRoot, `ranker-${name}`, merged, [
        views.shape[0],
        ...trailingShapes[name],
      ]);
    }
    return {
      dynamic_batch_sizes: [
        ...new Set(slices.map(([start, end]) => end - start)),
      ],
      input_names: [...session.inputNames],
      output_names: [...session.outputNames],
      outputs,
    };
  } finally {
    await session.release();
  }
}

/**
 * @param {string[]} argv
 * @returns {{ request: string; response: string }}
 */
function parseArguments(argv) {
  /** @type {Partial<{ request: string; response: string }>} */
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--request" || value === "--response") {
      const key = value === "--request" ? "request" : "response";
      result[key] = requireText(argv[index + 1], value);
      index += 1;
    }
  }
  if (!result.request || !result.response) {
    fail("--request and --response are required");
  }
  return { request: result.request, response: result.response };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const requestPath = resolve(args.request);
  const responsePath = resolve(args.response);
  const requestRoot = dirname(requestPath);
  const request = requireObject(
    JSON.parse(readFileSync(requestPath, "utf8")),
    "request",
  );
  if (request.schema_version !== REQUEST_SCHEMA) {
    fail("unsupported parity request schema");
  }
  const runtime = requireObject(request.runtime, "runtime");
  const outputRoot = resolve(
    requestRoot,
    requireText(request.output_dir, "output_dir"),
  );
  const rootPrefix = `${realpathSync(requestRoot)}${require("node:path").sep}`;
  mkdirSync(outputRoot, { recursive: false });
  if (!realpathSync(outputRoot).startsWith(rootPrefix)) {
    fail("parity output directory escapes the request root");
  }

  const runtimeEntry = resolveRegularFile(
    requestRoot,
    runtime.entry,
    "runtime.entry",
    true,
  );
  const wasmModule = resolveRegularFile(
    requestRoot,
    runtime.wasm_module,
    "runtime.wasm_module",
    true,
  );
  const wasmBinary = resolveRegularFile(
    requestRoot,
    runtime.wasm_binary,
    "runtime.wasm_binary",
    true,
  );
  const packageJson = requireObject(
    JSON.parse(
      readFileSync(join(dirname(runtimeEntry), "..", "package.json"), "utf8"),
    ),
    "onnxruntime-web package.json",
  );
  if (
    packageJson.name !== EXPECTED_PACKAGE ||
    packageJson.version !== EXPECTED_VERSION
  ) {
    fail("onnxruntime-web package/version differs from the production pin");
  }

  const ort = /** @type {typeof import("onnxruntime-web")} */ (
    require(runtimeEntry)
  );
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: pathToFileURL(wasmModule).href,
    wasm: pathToFileURL(wasmBinary).href,
  };

  const startedAt = Date.now();
  const encoder = await runEncoder(
    ort,
    requestRoot,
    outputRoot,
    request.encoder,
  );
  const ranker = await runRanker(ort, requestRoot, outputRoot, request.ranker);
  const response = {
    all_outputs_finite: true,
    electron_version: process.versions.electron ?? null,
    encoder,
    execution_provider: "wasm",
    host: process.versions.electron ? "electron-main" : "node",
    package: EXPECTED_PACKAGE,
    ranker,
    request_sha256: sha256File(requestPath),
    runtime_milliseconds: Date.now() - startedAt,
    schema_version: RESPONSE_SCHEMA,
    version: EXPECTED_VERSION,
  };
  writeFileSync(responsePath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
}

// Electron loads its application entry through an internal bootstrap module,
// so `require.main === module` is not a reliable direct-execution test here.
// This file is a dedicated subprocess entry and therefore always executes.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
