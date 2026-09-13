import type * as Ort from "onnxruntime-node";
import type { DirectMlDeviceRequest } from "../runtimeSupport/directMlAdapterPolicy";
import type { ImageDecodeFallback } from "../inpainting/inpaintingTypes";
import { loadPageImage } from "../inpainting/imageIO";
import { KOHARU_LAYOUT_INPUT_SIZE } from "./constants";
import type { ComicPageDetectionResult } from "./contracts";
import { parseKoharuLayoutOutputs } from "./outputs";
import {
  prepareComicDetectorImage,
  type PreparedComicDetectorImage,
} from "./preprocess";
import {
  getKoharuLayoutSession,
  isKoharuDeviceLostError,
  withKoharuSessionLease,
} from "./session";
import { onnxRuntimeNode as ort } from "../runtimeSupport/nativeOnnxRuntime";
import {
  resolveKoharuInferenceBackend,
  runKoharuWasmInference,
} from "./wasmWorkerClient";

type KoharuDetectorWasmDependencies = Readonly<{
  loadImage: (
    imagePath: string,
    decodeFallback?: ImageDecodeFallback,
  ) => Promise<Electron.NativeImage>;
  prepareImage: (
    image: Electron.NativeImage,
    signal?: AbortSignal,
  ) => PreparedComicDetectorImage;
  resolveBackend: typeof resolveKoharuInferenceBackend;
  runWasmInference: typeof runKoharuWasmInference;
}>;

const defaultWasmDependencies: KoharuDetectorWasmDependencies = {
  loadImage: loadPageImage,
  prepareImage: prepareComicDetectorImage,
  resolveBackend: resolveKoharuInferenceBackend,
  runWasmInference: runKoharuWasmInference,
};

export async function detectKoharuPageLayout(
  options: {
    /** Callers must pass the original page image, not an inpainted derivative. */
    imagePath: string;
    modelPath: string;
    directMl?: DirectMlDeviceRequest;
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
  },
  dependencies: KoharuDetectorWasmDependencies = defaultWasmDependencies,
): Promise<ComicPageDetectionResult> {
  throwIfAborted(options.signal);
  const image = await dependencies.loadImage(
    options.imagePath,
    options.decodeFallback,
  );
  const prepared = dependencies.prepareImage(image, options.signal);
  if (dependencies.resolveBackend() === "wasm-worker") {
    return dependencies.runWasmInference({
      modelPath: options.modelPath,
      imageWidth: prepared.imageWidth,
      imageHeight: prepared.imageHeight,
      rgbChw: prepared.rgbChw,
      signal: options.signal,
    });
  }
  const input = new ort.Tensor("float32", prepared.rgbChw, [
    1,
    3,
    KOHARU_LAYOUT_INPUT_SIZE,
    KOHARU_LAYOUT_INPUT_SIZE,
  ]);
  try {
    const { outputs, provider } = await runNativeDetector(options, input);
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

async function runNativeDetector(
  options: Parameters<typeof getKoharuLayoutSession>[0],
  input: Ort.TypedTensor<"float32">,
) {
  const handle = await getKoharuLayoutSession(options);
  try {
    return {
      outputs: await runKoharuSession(handle.session, input, options.signal),
      provider: handle.provider,
    };
  } catch (error) {
    throwIfAborted(options.signal);
    if (handle.provider !== "dml" || !isKoharuDeviceLostError(error))
      throw error;
    try {
      const cpu = await getKoharuLayoutSession({
        ...options,
        providerPreference: ["cpu"],
      });
      return {
        outputs: await runKoharuSession(cpu.session, input, options.signal),
        provider: cpu.provider,
      };
    } catch (cpuError) {
      throwIfAborted(options.signal);
      throw new AggregateError(
        [error, cpuError],
        "Text Detector GPU와 CPU 처리가 모두 실패했습니다.",
        { cause: cpuError },
      );
    }
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
    if (signal?.aborted) disposeOutputs(outputs);
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
