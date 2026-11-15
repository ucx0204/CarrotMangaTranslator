import { join } from "node:path";
import {
  ensureRemoteFile,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import { logPipelineWarning } from "./pipelineLogger";

const RELEASE_BASE =
  "https://github.com/ucx0204/CarrotMangaTranslator/releases/download/font-glyph-ppocr-v02-20261116-r1";
const FILES = [
  {
    name: "manga_rec_v0.2.onnx",
    bytes: 21167540,
    sha256: "de12c84c63e62c80339e882e675983d886670dcb6f0147e1ed041afd6fa81888",
  },
  {
    name: "ppocrv6_dict.txt",
    bytes: 74947,
    sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
  },
] as const;

/** Optional CPU accelerator: a failed download keeps the existing Hayai path. */
export async function prepareFontGlyphVerificationAssets(options: {
  dataRoot: string;
  signal: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<string | undefined> {
  const modelDir = join(options.dataRoot, "models", "font-glyph-ppocr-v02-r2");
  try {
    for (const file of FILES) {
      await ensureRemoteFile({
        modelDir,
        fileName: file.name,
        url: `${RELEASE_BASE}/${file.name}`,
        label: "Font glyph verification",
        expectedSha256: file.sha256,
        minimumBytes: file.bytes,
        maximumBytes: file.bytes,
        expectedTotalBytes: file.bytes,
        progressPhase: "font_matching_downloading",
        signal: options.signal,
        onProgress: options.onProgress,
      });
    }
    options.signal.throwIfAborted();
    return modelDir;
  } catch (error) {
    options.signal.throwIfAborted();
    logPipelineWarning("Font glyph accelerator unavailable; using Hayai", {
      error,
    });
    return undefined;
  }
}
