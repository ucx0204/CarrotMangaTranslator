import { basename, delimiter, dirname } from "node:path";
import {
  JsonLinesWorkerClient,
  type JsonLinesWorkerResponse,
} from "../runtimeSupport/jsonLinesWorkerClient";
import { logAnimeTextInfo, logAnimeTextWarning } from "./animeTextLogger";
import {
  parseAnimeTextDetection,
  type AnimeTextDetection,
} from "./animeTextContracts";

export type AnimeTextWorkerLaunchSpec = {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

type AnimeTextWorkerCommand = {
  type: "detect_text";
  input: string;
  confidence_threshold: number;
  nms_threshold: number;
};

type AnimeTextWorkerResponse = JsonLinesWorkerResponse & {
  result?: unknown;
};

const DETECTION_TIMEOUT_MS = 2 * 60 * 1000;

export class AnimeTextWorker {
  private readonly client: JsonLinesWorkerClient<
    AnimeTextWorkerCommand,
    AnimeTextWorkerResponse
  >;

  constructor(private readonly launch: AnimeTextWorkerLaunchSpec) {
    this.client = new JsonLinesWorkerClient({
      executable: launch.executable,
      args: launch.args,
      env: buildWorkerEnv(launch),
      workerName: "anime-text-yolo 텍스트 영역 탐지기",
      requestTimeoutMs: DETECTION_TIMEOUT_MS,
      buildExitError: (code, stderr) =>
        new Error(
          `anime-text-yolo 런타임이 종료되었습니다 (${code}). ${formatRuntimeDetail(stderr)}`,
        ),
      buildNotRunningError: (stderr) =>
        new Error(
          `anime-text-yolo 런타임이 실행 중이 아닙니다. ${formatRuntimeDetail(stderr)}`,
        ),
      sanitizeStderr: sanitizeRuntimeStderr,
      onStderr: logRuntimeStderr,
      onSpawn: (pid) =>
        logAnimeTextInfo("anime-text-yolo worker starting", {
          pid,
          executable: launch.executable,
          args: launch.args,
        }),
    });
  }

  async detect(
    input: string,
    signal?: AbortSignal,
  ): Promise<AnimeTextDetection> {
    const { id, response } = this.client.startRequest(
      {
        type: "detect_text",
        input,
        confidence_threshold: 0.25,
        nms_threshold: 0.45,
      },
      signal,
    );
    const result = await response;
    if (!result.ok) {
      throw new Error(
        `anime-text-yolo 탐지 실패: ${result.error ?? "알 수 없는 오류"}`,
      );
    }
    const detection = parseAnimeTextDetection(result.result);
    logAnimeTextInfo("anime-text-yolo detection completed", {
      requestId: id,
      inputFile: basename(input),
      elapsedMs: normalizeElapsedMs(result.elapsed_ms),
      regionCount: detection.regions.length,
    });
    return detection;
  }

  isHealthy(): boolean {
    return this.client.isHealthy();
  }

  async dispose(): Promise<void> {
    await this.client.dispose();
  }
}

function buildWorkerEnv(launch: AnimeTextWorkerLaunchSpec): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...launch.env,
    PATH: [launch.env?.PATH, dirname(launch.executable), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
    RUST_BACKTRACE: launch.env?.RUST_BACKTRACE ?? "1",
    RUST_LOG: launch.env?.RUST_LOG ?? "warn",
  };
}

function sanitizeRuntimeStderr(text: string): string {
  return text
    .replace(
      /[A-Z]:\\Users\\[^\\\r\n]+\\\.cargo\\(?:registry\\src|git\\checkouts)\\[^:\r\n]+/gi,
      "<rust-source>",
    )
    .replace(
      /\/Users\/[^/\r\n]+\/\.cargo\/(?:registry\/src|git\/checkouts)\/[^:\r\n]+/g,
      "<rust-source>",
    );
}

function formatRuntimeDetail(stderr: string): string {
  const detail = sanitizeRuntimeStderr(stderr)
    .replace(/\s+/g, " ")
    .trim()
    .slice(-1200);
  return detail ? `detail=${detail}` : "";
}

function logRuntimeStderr(text: string): void {
  for (const line of text.split(/\r?\n/).map((value) => value.trim())) {
    if (line.startsWith("mgt-koharu-inpaint-runner:")) {
      logAnimeTextInfo("anime-text-yolo runtime", { line });
    } else if (line) {
      logAnimeTextWarning("anime-text-yolo runtime warning", { line });
    }
  }
}

function normalizeElapsedMs(value: unknown): number | undefined {
  const elapsedMs = Number(value);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : undefined;
}
