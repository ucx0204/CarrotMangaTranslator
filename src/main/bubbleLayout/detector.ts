import type { DirectMlDeviceRequest } from "../runtimeSupport/directMlAdapterPolicy";
import type { ImageDecodeFallback } from "../inpainting/inpaintingTypes";
import { loadPageImage } from "../inpainting/imageIO";
import type {
  ComicPageDetectionResult,
  KoharuExecutionProvider,
} from "./contracts";
import {
  prepareComicDetectorImage,
  type PreparedComicDetectorImage,
} from "./preprocess";
import { tryCudaLayout } from "./cudaDetector";
import { nativeLayoutProcess } from "./session";
import { cacheNativeLayoutResults } from "./nativeResultCache";
import {
  resolveKoharuInferenceBackend,
  runKoharuWasmInference,
} from "./wasmWorkerClient";
import { runLocalInference } from "../runtimeSupport/localInferenceSection";

type KoharuDetectorDependencies = Readonly<{
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
  runNativeInference: typeof nativeLayoutProcess.run;
}>;

const defaultDependencies: KoharuDetectorDependencies = {
  loadImage: loadPageImage,
  prepareImage: prepareComicDetectorImage,
  resolveBackend: resolveKoharuInferenceBackend,
  runWasmInference: runKoharuWasmInference,
  runNativeInference: cacheNativeLayoutResults(
    async (request, signal) =>
      (await tryCudaLayout(request, signal)) ??
      nativeLayoutProcess.run(request, signal),
  ),
};

/** Layout detection is a local inference stage shared with detection and OCR. */
export function detectKoharuPageLayout(
  options: Parameters<typeof detectKoharuPageLayoutNow>[0],
  dependencies?: KoharuDetectorDependencies,
): Promise<ComicPageDetectionResult> {
  return runLocalInference(
    () => detectKoharuPageLayoutNow(options, dependencies),
    options.signal,
  );
}

async function detectKoharuPageLayoutNow(
  options: {
    /** Callers must pass the original page image, not an inpainted derivative. */
    imagePath: string;
    /** Already decoded original crop used for a second native-scale text pass. */
    originalCrop?: Electron.NativeImage;
    modelPath: string;
    directMl?: DirectMlDeviceRequest;
    providerPreference?: readonly KoharuExecutionProvider[];
    signal?: AbortSignal;
    decodeFallback?: ImageDecodeFallback;
  },
  dependencies: KoharuDetectorDependencies = defaultDependencies,
): Promise<ComicPageDetectionResult> {
  options.signal?.throwIfAborted();
  const image =
    options.originalCrop ??
    (await dependencies.loadImage(options.imagePath, options.decodeFallback));
  options.signal?.throwIfAborted();
  if (dependencies.resolveBackend() === "wasm-worker") {
    const prepared = dependencies.prepareImage(image, options.signal);
    return dependencies.runWasmInference({
      modelPath: options.modelPath,
      imageWidth: prepared.imageWidth,
      imageHeight: prepared.imageHeight,
      rgbChw: prepared.rgbChw,
      signal: options.signal,
    });
  }
  const { width, height } = image.getSize();
  return dependencies.runNativeInference(
    {
      bitmap: image.toBitmap(),
      width,
      height,
      modelPath: options.modelPath,
      directMl: options.directMl,
      providerPreference: options.providerPreference,
    },
    options.signal,
  );
}
