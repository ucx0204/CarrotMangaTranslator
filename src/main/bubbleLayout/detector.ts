import type * as Ort from "onnxruntime-node";
import type { ImageDecodeFallback } from "../inpainting/inpaintingTypes";
import { loadPageImage } from "../inpainting/imageIO";
import { KOHARU_LAYOUT_INPUT_SIZE } from "./constants";
import type { ComicPageDetectionResult } from "./contracts";
import { parseKoharuLayoutOutputs } from "./outputs";
import { prepareComicDetectorImage } from "./preprocess";
import { getKoharuLayoutSession, withKoharuSessionLease } from "./session";
import { onnxRuntimeNode as ort } from "../runtimeSupport/nativeOnnxRuntime";

export async function detectKoharuPageLayout(options: {
  /** Callers must pass the original page image, not an inpainted derivative. */
  imagePath: string;
  modelPath: string;
  signal?: AbortSignal;
  decodeFallback?: ImageDecodeFallback;
}): Promise<ComicPageDetectionResult> {
  throwIfAborted(options.signal);
  const image = await loadPageImage(options.imagePath, options.decodeFallback);
  const prepared = prepareComicDetectorImage(image, options.signal);
  const { session, provider } = await getKoharuLayoutSession({
    modelPath: options.modelPath,
    signal: options.signal,
  });
  const input = new ort.Tensor("float32", prepared.rgbChw, [
    1,
    3,
    KOHARU_LAYOUT_INPUT_SIZE,
    KOHARU_LAYOUT_INPUT_SIZE,
  ]);
  try {
    const outputs = await runKoharuSession(session, input, options.signal);
    try {
      return {
        imageWidth: prepared.imageWidth,
        imageHeight: prepared.imageHeight,
        detections: parseKoharuLayoutOutputs(outputs, {
          width: prepared.imageWidth,
          height: prepared.imageHeight,
        }),
        executionProvider: provider,
      };
    } finally {
      disposeOutputs(outputs);
    }
  } finally {
    input.dispose();
  }
}

async function runKoharuSession(
  session: Ort.InferenceSession,
  input: Ort.TypedTensor<"float32">,
  signal?: AbortSignal,
): Promise<Ort.InferenceSession.ReturnType> {
  throwIfAborted(signal);
  const runOptions: Ort.InferenceSession.RunOptions = { terminate: false };
  const terminate = (): void => {
    runOptions.terminate = true;
  };
  signal?.addEventListener("abort", terminate, { once: true });
  try {
    const outputs = await withKoharuSessionLease(session, signal, () =>
      session.run({ input }, ["dets", "labels", "masks"], runOptions),
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

function disposeOutputs(outputs: Ort.InferenceSession.ReturnType): void {
  for (const value of Object.values(outputs)) {
    value.dispose?.();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
