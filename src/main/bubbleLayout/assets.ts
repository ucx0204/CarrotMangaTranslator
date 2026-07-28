import { join } from "node:path";
import {
  ensureRemoteFile,
  hfResolveUrl,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import {
  COMIC_BUBBLE_DETECTOR_BYTES,
  COMIC_BUBBLE_DETECTOR_FILE,
  COMIC_BUBBLE_DETECTOR_REPO,
  COMIC_BUBBLE_DETECTOR_REVISION,
  COMIC_BUBBLE_DETECTOR_SHA256,
} from "./constants";

export const COMIC_BUBBLE_DETECTOR_URL = hfResolveUrl(
  COMIC_BUBBLE_DETECTOR_REPO,
  COMIC_BUBBLE_DETECTOR_FILE,
  COMIC_BUBBLE_DETECTOR_REVISION,
);

export async function ensureComicBubbleDetectorModel(options: {
  dataRoot: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<string> {
  throwIfAborted(options.signal);
  const modelPath = await ensureRemoteFile({
    modelDir: join(
      options.dataRoot,
      "models",
      "bubble-layout",
      "comic-text-and-bubble-detector",
    ),
    url: COMIC_BUBBLE_DETECTOR_URL,
    fileName: COMIC_BUBBLE_DETECTOR_FILE,
    label: "comic-text-and-bubble-detector",
    expectedSha256: COMIC_BUBBLE_DETECTOR_SHA256,
    minimumBytes: COMIC_BUBBLE_DETECTOR_BYTES,
    progressPhase: "bubble_layout_preparing",
    signal: options.signal,
    onProgress: options.onProgress,
  });
  throwIfAborted(options.signal);
  return modelPath;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
