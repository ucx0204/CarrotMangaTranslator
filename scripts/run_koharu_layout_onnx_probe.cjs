"use strict";

const { availableParallelism } = require("node:os");
const { resolve } = require("node:path");
const { app, nativeImage } = require("electron");

const INPUT_SIZE = 1152;
const QUERY_COUNT = 300;
const CLASS_THRESHOLDS = [0.25, 0.2, 0.5, 0.5];
const CLASS_NAMES = ["text", "onomatopoeia", "bubble", "panel"];

/** @param {string} message */
function fail(message) {
  throw new Error(message);
}

/**
 * @param {string[]} argv
 * @returns {{ model: string; image: string; provider: "cpu" | "dml" | "webgpu" }}
 */
function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail(`Invalid argument at position ${index}: ${name ?? "<missing>"}`);
    }
    if (values.has(name)) fail(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  const model = values.get("--model");
  const image = values.get("--image");
  const provider = values.get("--provider") ?? "cpu";
  if (!model || !image || !["cpu", "dml", "webgpu"].includes(provider)) {
    fail(
      "Usage: --model <onnx> --image <manga-page> [--provider cpu|dml|webgpu]",
    );
  }
  const allowed = values.has("--provider") ? 3 : 2;
  if (values.size !== allowed) fail("Unknown command-line argument");
  return {
    model: resolve(model),
    image: resolve(image),
    provider: /** @type {"cpu" | "dml" | "webgpu"} */ (provider),
  };
}

/** @param {Electron.NativeImage} source */
function prepareInput(source) {
  const resized = source.resize({
    width: INPUT_SIZE,
    height: INPUT_SIZE,
    quality: "best",
  });
  const bitmap = resized.toBitmap();
  const pixels = INPUT_SIZE * INPUT_SIZE;
  const output = new Float32Array(pixels * 3);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let index = 0; index < pixels; index += 1) {
    const sourceOffset = index * 4;
    output[index] = ((bitmap[sourceOffset + 2] ?? 0) / 255 - mean[0]) / std[0];
    output[pixels + index] =
      ((bitmap[sourceOffset + 1] ?? 0) / 255 - mean[1]) / std[1];
    output[pixels * 2 + index] =
      ((bitmap[sourceOffset] ?? 0) / 255 - mean[2]) / std[2];
  }
  return output;
}

/** @param {ArrayLike<number | bigint>} data */
function summarizeLabels(data) {
  const counts = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let query = 0; query < QUERY_COUNT; query += 1) {
    let bestClass = -1;
    let bestScore = -Infinity;
    for (let classId = 0; classId < 4; classId += 1) {
      const raw = Number(data[query * 5 + classId]);
      minimum = Math.min(minimum, raw);
      maximum = Math.max(maximum, raw);
      const score = 1 / (1 + Math.exp(-raw));
      if (score > bestScore) {
        bestScore = score;
        bestClass = classId;
      }
    }
    if (bestScore >= CLASS_THRESHOLDS[bestClass]) {
      counts[CLASS_NAMES[bestClass]] += 1;
    }
  }
  return { rawMinimum: minimum, rawMaximum: maximum, keptClassCounts: counts };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = nativeImage.createFromPath(args.image);
  if (source.isEmpty()) fail(`Cannot decode image: ${args.image}`);
  const ort = require("onnxruntime-node");
  const threads = Math.max(1, Math.min(8, availableParallelism()));
  const started = performance.now();
  const session = await ort.InferenceSession.create(args.model, {
    executionProviders: [args.provider],
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    intraOpNumThreads: args.provider === "cpu" ? threads : 1,
    interOpNumThreads: 1,
    enableMemPattern: args.provider === "cpu",
  });
  const sessionMs = performance.now() - started;
  const inputData = prepareInput(source);
  const input = new ort.Tensor("float32", inputData, [
    1,
    3,
    INPUT_SIZE,
    INPUT_SIZE,
  ]);
  const inferenceStarted = performance.now();
  const outputs = await session.run({ input }, ["dets", "labels", "masks"]);
  const inferenceMs = performance.now() - inferenceStarted;
  const result = {
    ok: true,
    provider: args.provider,
    threads,
    sourceSize: source.getSize(),
    sessionMs,
    inferenceMs,
    inputs: session.inputNames,
    outputs: Object.fromEntries(
      session.outputNames.map((name) => [name, outputs[name]?.dims ?? null]),
    ),
    labels: summarizeLabels(
      /** @type {ArrayLike<number | bigint>} */ (outputs.labels.data),
    ),
    rssBytes: process.memoryUsage().rss,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  input.dispose();
  for (const output of Object.values(outputs)) output.dispose?.();
  await session.release();
}

app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      app.exit(1);
    },
  );
