import * as ort from "onnxruntime-web";
import type { ImageDecodeFallback } from "../inpainting/inpaintingTypes";
import { loadPageImage } from "../inpainting/imageIO";
import { COMIC_BUBBLE_DETECTOR_INPUT_SIZE } from "./constants";
import type { ComicPageDetectionResult } from "./contracts";
import { parseComicDetectorOutputs } from "./outputs";
import { prepareComicDetectorImage } from "./preprocess";
import { getComicBubbleDetectorSession } from "./session";

export async function detectComicPageLayout(options: {
  /** Callers should pass the original page image, not an inpainted derivative. */
  imagePath: string;
  modelPath: string;
  scoreThreshold?: number;
  signal?: AbortSignal;
  decodeFallback?: ImageDecodeFallback;
}): Promise<ComicPageDetectionResult> {
  throwIfAborted(options.signal);
  const image = await loadPageImage(options.imagePath, options.decodeFallback);
  const prepared = prepareComicDetectorImage(image, options.signal);
  const session = await getComicBubbleDetectorSession(
    options.modelPath,
    options.signal,
  );
  const inputs = createDetectorInputs(prepared);
  try {
    const outputs = await runDetectorSession(session, inputs, options.signal);
    try {
      return {
        imageWidth: prepared.imageWidth,
        imageHeight: prepared.imageHeight,
        detections: parseComicDetectorOutputs(
          outputs,
          { width: prepared.imageWidth, height: prepared.imageHeight },
          options.scoreThreshold,
        ),
      };
    } finally {
      disposeOutputs(outputs);
    }
  } finally {
    inputs.images.dispose();
    inputs.orig_target_sizes.dispose();
  }
}

type DetectorInputs = {
  images: ort.TypedTensor<"float32">;
  orig_target_sizes: ort.TypedTensor<"int64">;
};

function createDetectorInputs(prepared: {
  imageWidth: number;
  imageHeight: number;
  rgbChw: Float32Array;
}): DetectorInputs {
  return {
    images: new ort.Tensor("float32", prepared.rgbChw, [
      1,
      3,
      COMIC_BUBBLE_DETECTOR_INPUT_SIZE,
      COMIC_BUBBLE_DETECTOR_INPUT_SIZE,
    ]),
    // This exported model expects the original target pair in width, height
    // order. Keep BigInt64Array so the tensor remains true ONNX int64.
    orig_target_sizes: new ort.Tensor(
      "int64",
      BigInt64Array.of(
        BigInt(prepared.imageWidth),
        BigInt(prepared.imageHeight),
      ),
      [1, 2],
    ),
  };
}

async function runDetectorSession(
  session: ort.InferenceSession,
  inputs: DetectorInputs,
  signal?: AbortSignal,
): Promise<ort.InferenceSession.ReturnType> {
  throwIfAborted(signal);
  const runOptions: ort.InferenceSession.RunOptions = { terminate: false };
  const terminate = (): void => {
    runOptions.terminate = true;
  };
  signal?.addEventListener("abort", terminate, { once: true });
  try {
    const outputs = await session.run(
      inputs,
      ["labels", "boxes", "scores"],
      runOptions,
    );
    throwIfAborted(signal);
    return outputs;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  } finally {
    signal?.removeEventListener("abort", terminate);
  }
}

function disposeOutputs(outputs: ort.InferenceSession.ReturnType): void {
  for (const value of Object.values(outputs)) {
    if (typeof value.dispose === "function") value.dispose();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
