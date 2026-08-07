import { join } from "node:path";
import { ensureManagedKoharuRunner } from "../runtimeSupport/koharuRunner";
import {
  ensureRemoteFile,
  hfResolveUrl,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import type { AnimeTextWorkerLaunchSpec } from "./animeTextWorker";
import { ANIME_TEXT_MODEL_REVISION as EVIDENCE_MODEL_REVISION } from "./animeTextEvidenceContract";

const ANIME_TEXT_MODEL_REPO = "mayocream/anime-text-yolo";
const ANIME_TEXT_MODEL_REVISION = EVIDENCE_MODEL_REVISION;
const ANIME_TEXT_MODEL_FILE = "yolo12n_animetext.safetensors";
const ANIME_TEXT_MODEL_SHA256 =
  "79bbe16deb26aff8094ebf1f262f74062a4a25df0c47ab0ddbcf20305c7b68eb";
const ANIME_TEXT_MODEL_BYTES = 10_433_860;

export async function prepareAnimeTextWorkerLaunch(options: {
  dataRoot: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<AnimeTextWorkerLaunchSpec> {
  const runtimeDir = join(options.dataRoot, "runtime", "koharu-text-detection");
  const [managedRunner, weightsPath] = await Promise.all([
    ensureManagedKoharuRunner({
      runtimeDir,
      signal: options.signal,
    }),
    ensureRemoteFile({
      modelDir: join(
        options.dataRoot,
        "models",
        "text-detection",
        "anime-text-yolo",
      ),
      url: hfResolveUrl(
        ANIME_TEXT_MODEL_REPO,
        ANIME_TEXT_MODEL_FILE,
        ANIME_TEXT_MODEL_REVISION,
      ),
      fileName: ANIME_TEXT_MODEL_FILE,
      label: "anime-text-yolo",
      expectedSha256: ANIME_TEXT_MODEL_SHA256,
      minimumBytes: ANIME_TEXT_MODEL_BYTES,
      expectedTotalBytes: ANIME_TEXT_MODEL_BYTES,
      maximumBytes: ANIME_TEXT_MODEL_BYTES,
      progressPhase: "ocr_preparing",
      signal: options.signal,
      onProgress: options.onProgress,
    }),
  ]);
  return {
    executable: managedRunner.path,
    args: buildAnimeTextRunnerArgs(weightsPath),
    env: {
      KOHARU_DATA_ROOT: join(runtimeDir, "koharu-data"),
    },
  };
}

export function buildAnimeTextRunnerArgs(weightsPath: string): string[] {
  if (!weightsPath.trim()) {
    throw new Error("anime-text-yolo weights path is required.");
  }
  return [
    "--model",
    "anime-text-yolo",
    "--weights",
    weightsPath,
    "--backend",
    "cpu",
  ];
}
