import {
  JsonLinesWorkerClient,
  type JsonLinesWorkerResponse,
} from "../runtimeSupport/jsonLinesWorkerClient";
import { nativeImage, type NativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  qwenPrintTools,
  type ensureQwenControlRuntime,
} from "./qwenControlRuntime";
import type { PixelRect } from "./maskGeometry";
type Size = { width: number; height: number };
export type NativePrintLaunch = Pick<
  Awaited<ReturnType<typeof ensureQwenControlRuntime>>,
  "executable" | "packageDirectory"
> & { script: string };
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const nativeThreads = {
  PYTHONNOUSERSITE: "1",
  OPENBLAS_NUM_THREADS: "1",
  MKL_NUM_THREADS: "1",
  OMP_NUM_THREADS: "1",
};
export async function writeQwenRuleReferences(
  launch: NativePrintLaunch,
  source: string,
  view: PixelRect &
    (
      | { mask: string; radius: number }
      | { guide: string }
      | { mask: string; nativeInk: true }
    ),
  size: Size,
  paths: { first: string; original: string; mask: string },
  signal?: AbortSignal,
) {
  await execute(
    launch.executable,
    [
      "-s",
      "-B",
      "-X",
      "utf8",
      join(dirname(launch.script), "qwen-rule-references.py"),
      join(dirname(launch.packageDirectory), qwenPrintTools),
      source,
      "guide" in view ? view.guide : view.mask,
      paths.first,
      paths.original,
      paths.mask,
      ...[
        view.x,
        view.y,
        view.w,
        view.h,
        size.width,
        size.height,
        "guide" in view
          ? "display"
          : "nativeInk" in view
            ? "native-ink"
            : view.radius,
      ].map(String),
    ],
    { signal, windowsHide: true, env: { ...process.env, ...nativeThreads } },
  );
}
type InkRegistration =
  | "qwen_screen_transfer.py"
  | "qwen-motion-lines.py"
  | "qwen-register-contours.py"
  | "qwen-register-substrate.py"
  | "qwen-reconnect-balloon.py"
  | "qwen-title-stock.py"
  | "qwen-restore-illustration.py";
export class QwenNativePrintRegistration {
  constructor(private readonly launch: NativePrintLaunch) {}
  private client?: JsonLinesWorkerClient<
    { script: string; args: string[] },
    JsonLinesWorkerResponse & { stdout?: string }
  >;

  async dispose() {
    await this.client?.dispose();
    this.client = undefined;
  }

  private async run(script: string, args: string[], signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.client?.isHealthy()) {
      await this.dispose();
      this.client = new JsonLinesWorkerClient({
        executable: this.launch.executable,
        args: [
          "-s",
          "-B",
          "-X",
          "utf8",
          join(dirname(this.launch.script), "qwen-print-session.py"),
        ],
        env: { ...process.env, ...nativeThreads },
        workerName: "Qwen print repair",
        buildExitError: (code, tail) =>
          new Error("Qwen print repair (" + code + "): " + tail),
        buildNotRunningError: (tail) => new Error("Qwen print repair: " + tail),
        sanitizeStderr: (text) => text,
        onStderr: () => {},
        onTerminationError: (error) => console.error(error),
      });
    }
    const reply = await this.client.startRequest({ script, args }, signal)
      .response;
    if (!reply.ok || typeof reply.stdout !== "string")
      throw new Error(reply.error || "Qwen 원본 복원 작업이 실패했습니다.");
    return { stdout: reply.stdout };
  }

  async printedTitleReference(
    hint: unknown,
    source: string,
    mask: string | undefined,
    size: Size,
    signal: AbortSignal,
  ) {
    if (hint === "upright-jacket")
      return {
        pairedWindow: {
          x: 0,
          y: 0,
          w: size.width,
          h: size.height,
          guide: source,
        },
      };
    if (
      !mask ||
      typeof hint !== "string" ||
      !hint.startsWith("layered-title:") ||
      hint.length <= "layered-title:".length ||
      size.width < 450 ||
      size.height < 170
    )
      return;
    const view = await this.displayTitleView(source, mask, size, signal);
    if (view)
      return {
        pairedWindow: view,
        printDescription:
          "Repair the erased part of the first manga crop. The second reference shows its unedited illustration with printed ocr. Use the original edges outside the erasure as exact guides. Continue any interrupted contours through the gap with the original stroke width and tangent. Match the original paper, tone, shadow and print texture. Preserve decorative frames and objects. Leave the restored area completely free of lettering, glyphs, punctuation and replacement symbols.",
      };
  }
  async displayTitleView(
    source: string,
    mask: string,
    size: Size,
    signal: AbortSignal,
  ) {
    const guide = source + ".display-guide.png";
    const { packageDirectory } = this.launch;
    const { stdout } = await this.run(
      "qwen_layered_ink.py",
      [join(dirname(packageDirectory), qwenPrintTools), source, mask, guide],
      signal,
    );
    if (stdout.trim() === "unchanged") return;
    const view: PixelRect = JSON.parse(stdout);
    if (
      ![view.x, view.y, view.w, view.h].every(Number.isSafeInteger) ||
      view.x < 0 ||
      view.y < 0 ||
      view.w <= 0 ||
      view.h <= 0 ||
      view.x + view.w > size.width ||
      view.y + view.h > size.height
    )
      throw new Error("Qwen 표지 참조 영역이 원본 범위를 벗어났습니다.");
    return { ...view, guide };
  }
  async processJacketPlane(
    mode: "prepare" | "compose",
    source: string,
    mask: string,
    directory: string,
    signal: AbortSignal,
  ) {
    const { packageDirectory } = this.launch;
    const { stdout } = await this.run(
      "qwen_jacket_plane.py",
      [
        join(dirname(packageDirectory), qwenPrintTools),
        mode,
        source,
        mask,
        directory,
      ],
      signal,
    );
    if (stdout.trim() === "applied") return true;
    if (mode === "prepare" && stdout.trim() === "unchanged") return false;
    throw new Error("Qwen이 작은 표지의 원본 좌표를 확인할 수 없습니다.");
  }
  async exposedContourError(
    input: string,
    mask: string,
    decoded: string,
    signal: AbortSignal,
  ) {
    const { stdout } = await this.run(
      "qwen-restore-illustration.py",
      [input, mask, decoded, "--edge-score"],
      signal,
    );
    const score = Number(stdout.trim());
    if (!stdout.trim() || !Number.isFinite(score) || score < -1 || score > 1)
      throw new Error("Qwen의 표지 윤곽 측정 결과를 읽을 수 없습니다.");
    return score;
  }

  async remainingCoverPrint(
    input: string,
    mask: string,
    decoded: string,
    residualMask: string,
    mode: "masthead" | "columns" | "ink-terminal",
    signal: AbortSignal,
  ) {
    const { stdout } = await this.run(
      "qwen_cover_residual.py",
      [input, mask, decoded, residualMask, mode],
      signal,
    );
    return JSON.parse(stdout) as
      | (Size & { x: number; y: number; score: number; fragment?: number })
      | null;
  }

  async registerImage(
    script: InkRegistration,
    input: string,
    mask: string,
    source: NativeImage,
    signal: AbortSignal,
    mode?: string,
  ): Promise<NativeImage | undefined> {
    const size = source.getSize();
    const file = input + "." + randomUUID() + ".png";
    try {
      await writeFile(file, source.toPNG());
      if (
        !(await this.applyNativeDetail(script, input, mask, file, signal, mode))
      )
        return;
      const image = nativeImage.createFromBuffer(await readFile(file));
      const measured = image.getSize();
      if (measured.width !== size.width || measured.height !== size.height)
        throw new Error("Qwen 윤곽선 보정 결과의 크기가 원본과 다릅니다.");
      return image;
    } finally {
      await rm(file, { force: true });
    }
  }

  async applyNativeDetail(
    script:
      "qwen-screen-detail.py" | "qwen-reconnect-balloon.py" | InkRegistration,
    input: string,
    mask: string,
    output: string,
    signal: AbortSignal,
    mode?: string,
  ): Promise<boolean> {
    const staged = output + "." + randomUUID() + ".png";
    try {
      const { stdout } = await this.run(
        script,
        [input, mask, output, staged, ...(mode ? [mode] : [])],
        signal,
      );
      signal.throwIfAborted();
      if (stdout.trim() === "unchanged") return false;
      if (stdout.trim() !== "applied")
        throw new Error("Qwen 윤곽선·망점 복원 결과를 확인할 수 없습니다.");
      await rename(staged, output);
      return true;
    } finally {
      await rm(staged, { force: true });
    }
  }
}
