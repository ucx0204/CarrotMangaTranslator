import { createHash } from "node:crypto";
import type * as Ort from "onnxruntime-node";
import artifact from "./fontTextureModel.json";
import {
  onnxRuntimeNode as ort,
  runDisposableFloatTensorStage,
} from "../runtimeSupport/nativeOnnxRuntime";
import {
  prepareFontTextureSupport,
  FONT_TEXTURE_PATCH_SIZE,
} from "./fontMatchingTextureSupport";
import {
  FONT_TEXTURE_CLASSES,
  FONT_TEXTURE_WEIGHTS,
  FONT_TEXTURE_CONTRACT,
  FONT_TEXTURE_MODEL_SHA256,
} from "./fontMatchingTextureTypes";
import type {
  FontMatchingPageInferenceBlock,
  VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRasterPage } from "./fontMatchingPagePixelPreprocessing";

export async function loadFontTextureModel(): Promise<Ort.InferenceSession> {
  const bytes = Buffer.from(artifact.onnxBase64, "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    artifact.schema !== "font-texture-onnx-v1" ||
    bytes.length !== artifact.byteSize ||
    digest !== FONT_TEXTURE_MODEL_SHA256 ||
    artifact.modelSha256 !== digest ||
    artifact.classes.join("/") !== FONT_TEXTURE_CLASSES.join("/") ||
    artifact.weights.join("/") !== FONT_TEXTURE_WEIGHTS.join("/")
  )
    throw new Error("Source font texture model integrity check failed.");
  return ort.InferenceSession.create(bytes, {
    executionProviders: ["cpu"],
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  });
}

/** Mean per-patch affine logits equals the frozen heads applied to the mean descriptor. */
export async function inferFontTexturePage(options: {
  session: Ort.InferenceSession;
  blocks: readonly FontMatchingPageInferenceBlock[];
  rows: ReadonlyMap<string, VerifiedAutomaticFontPixelInferenceV2>;
  raster: FontMatchingRasterPage;
  signal?: AbortSignal;
}) {
  const output = new Map(options.rows);
  for (const block of options.blocks) {
    options.signal?.throwIfAborted();
    const row = options.rows.get(block.blockId);
    if (!row?.crossScriptProxy) continue;
    const support = prepareFontTextureSupport(
      options.raster,
      block.item.bbox,
      options.signal,
    );
    if (!support || support.count < 2) continue;
    const means = await runDisposableFloatTensorStage({
      session: options.session,
      inputName: "ink",
      outputName: "logits",
      input: new ort.Tensor("float32", support.values, [
        support.count,
        1,
        FONT_TEXTURE_PATCH_SIZE,
        FONT_TEXTURE_PATCH_SIZE,
      ]),
      expectedDimensions: [support.count, 15],
      consume: (logits) => {
        const result = Array<number>(15).fill(0);
        for (let i = 0; i < logits.length; i++) {
          if (!Number.isFinite(logits[i]))
            throw new Error("Invalid texture logits.");
          result[i % 15] += logits[i] / support.count;
        }
        return result;
      },
    });
    options.signal?.throwIfAborted();
    output.set(block.blockId, {
      ...row,
      sourceTexture: {
        contractVersion: FONT_TEXTURE_CONTRACT,
        modelSha256: FONT_TEXTURE_MODEL_SHA256,
        patchCount: support.count,
        probabilities: softmax(means.slice(0, 11)),
        weightProbabilities: softmax(means.slice(11)),
      },
    });
  }
  return output;
}

function softmax(values: readonly number[]) {
  const maximum = Math.max(...values),
    exp = values.map((v) => Math.exp(v - maximum)),
    sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / sum);
}
