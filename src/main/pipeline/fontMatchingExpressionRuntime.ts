import { createHash } from "node:crypto";
import type * as Ort from "onnxruntime-node";
import artifact from "./fontExpressionModel.json";
import {
  onnxRuntimeNode as ort,
  runDisposableFloatTensorStage,
} from "../runtimeSupport/nativeOnnxRuntime";
import {
  prepareFontExpressionSupport,
  FONT_EXPRESSION_COMPONENT_SIZE,
} from "./fontMatchingExpressionSupport";
import {
  FONT_EXPRESSION_CLASSES,
  FONT_EXPRESSION_CONTRACT,
  FONT_EXPRESSION_MODEL_SHA256,
  type FontExpressionInference,
} from "./fontMatchingExpressionTypes";
import type {
  FontMatchingPageInferenceBlock,
  VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";

/** Code-owned small model, verified before handing bytes to the shared native gateway. */
export async function loadFontExpressionModel(): Promise<Ort.InferenceSession> {
  const bytes = Buffer.from(artifact.onnxBase64, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    artifact.schema !== "font-expression-onnx-v1" ||
    bytes.length !== artifact.byteSize ||
    digest !== FONT_EXPRESSION_MODEL_SHA256 ||
    artifact.sha256 !== digest ||
    artifact.classes.join("/") !== FONT_EXPRESSION_CLASSES.join("/")
  ) {
    throw new Error("Source font expression model integrity check failed.");
  }
  return ort.InferenceSession.create(bytes, {
    executionProviders: ["cpu"],
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  });
}

export async function inferFontExpressionPage({
  session,
  blocks,
  rows,
  raster,
  signal,
}: {
  session: Ort.InferenceSession;
  blocks: readonly FontMatchingPageInferenceBlock[];
  rows: ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>;
  raster: FontMatchingRasterPage;
  signal?: AbortSignal;
}) {
  const output = new Map(rows);
  for (const block of blocks) {
    signal?.throwIfAborted();
    const row = rows.get(block.blockId);
    // Reuse the existing locale/catalog/ordinary-prose boundary. Display and
    // manually excluded candidates do not acquire a new path into matching.
    if (!row?.crossScriptProxy) continue;
    const support = prepareFontExpressionSupport(
      raster,
      block.item.bbox,
      signal,
    );
    if (!support || support.count < 2) continue;
    const probabilities = await runDisposableFloatTensorStage({
      session,
      inputName: "ink",
      outputName: "logits",
      input: new ort.Tensor("float32", support.values, [
        support.count,
        1,
        FONT_EXPRESSION_COMPONENT_SIZE,
        FONT_EXPRESSION_COMPONENT_SIZE,
      ]),
      expectedDimensions: [support.count, FONT_EXPRESSION_CLASSES.length],
      consume: (logits) =>
        aggregateExpressionProbabilities(logits, support.count),
    });
    signal?.throwIfAborted();
    const sourceExpression: FontExpressionInference = {
      contractVersion: FONT_EXPRESSION_CONTRACT,
      modelSha256: FONT_EXPRESSION_MODEL_SHA256,
      componentCount: support.count,
      probabilities,
    };
    output.set(block.blockId, { ...row, sourceExpression });
  }
  return output;
}

function aggregateExpressionProbabilities(logits: Float32Array, count: number) {
  const values = FONT_EXPRESSION_CLASSES.map(() => [] as number[]);
  for (let component = 0; component < count; component += 1) {
    const row = Array.from(
      logits.subarray(
        component * values.length,
        (component + 1) * values.length,
      ),
    );
    if (row.some((value) => !Number.isFinite(value)))
      throw new Error("Invalid expression logits.");
    const maximum = Math.max(...row);
    const exp = row.map((value) => Math.exp(value - maximum));
    const sum = exp.reduce((a, b) => a + b, 0);
    for (let index = 0; index < exp.length; index += 1)
      values[index]?.push((exp[index] ?? 0) / sum);
  }
  const medians = values.map((items) => {
    items.sort((a, b) => a - b);
    const middle = Math.floor(items.length / 2);
    return items.length % 2
      ? (items[middle] ?? 0)
      : ((items[middle - 1] ?? 0) + (items[middle] ?? 0)) / 2;
  });
  const sum = medians.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error("Empty expression probabilities.");
  return medians.map((value) => value / sum);
}
