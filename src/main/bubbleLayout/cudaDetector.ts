import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAppPaths } from "../appPaths";
import { queryNvidiaGpuInfo } from "../gpuInfo";
import { getLogPath, logWarn } from "../logger";
import {
  installedQwenControlPython,
  qwenKoffiPath,
} from "../inpainting/qwenControlRuntime";
import { QwenControlSession } from "../inpainting/qwenControlSession";
import { InferenceUtilityProcess } from "../runtimeSupport/inferenceUtilityProcess";
import { ensureRemoteFile } from "../runtimeSupport/modelDownloads";
import type {
  NativeLayoutRequest,
  ComicPageDetectionResult,
} from "./contracts";
import type { SparseLayoutTransfer } from "./sparseLayoutWorker";

const transfer = new InferenceUtilityProcess<
  SparseLayoutTransfer,
  ComicPageDetectionResult | null
>(join(__dirname, "sparseLayoutWorker.js"), "KoharuLayout raster", () =>
  getLogPath(),
);
const wheelName = "onnxruntime_gpu-1.30.0-cp313-cp313-win_amd64.whl";
const wheelSize = 160_479_611;
const failed = new Set<string>();
let active: Awaited<ReturnType<typeof createSession>>;
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>) {
  const next = tail.then(task);
  tail = Promise.allSettled([next]);
  return next;
}

async function createSession(
  request: NativeLayoutRequest,
  key: string,
  signal: AbortSignal,
) {
  const root = dirname(dirname(dirname(dirname(request.modelPath))));
  const executable = installedQwenControlPython(root);
  if (!existsSync(executable)) return;
  const gpu = await queryNvidiaGpuInfo(request.directMl?.computeGpuIndex);
  if (!gpu?.nvidiaUuid || (gpu.computeCapability ?? 0) < 7.5) return;
  const modelDir = join(dirname(request.modelPath), "cuda-ort-1.30.0");
  const wheel = await ensureRemoteFile({
    modelDir,
    fileName: wheelName,
    label: "KoharuLayout CUDA",
    url:
      "https://files.pythonhosted.org/packages/7e/d3/50fba71f4174f25f1e677ffe4b2ebc9f6c2a2aa8093c12e82c93792fd4e8/" +
      wheelName,
    expectedSha256:
      "cf494da233f3fc02bbeb2a3178e3ace7361b6b4fef7031b19c1e5aed5e9328ce",
    minimumBytes: wheelSize,
    maximumBytes: wheelSize,
    expectedTotalBytes: wheelSize,
    signal,
  });
  const runtime = getAppPaths().runtimeDir;
  const worker = new QwenControlSession({
    workerName: "KoharuLayout CUDA",
    executable,
    gpuUuid: gpu.nvidiaUuid,
    env: { CARROT_QWEN_KOFFI: qwenKoffiPath(runtime), PYTHONNOUSERSITE: "1" },
  });
  return { worker, key, wheel, script: join(runtime, "koharu-layout-cuda.py") };
}

async function infer(
  request: NativeLayoutRequest,
  session: NonNullable<typeof active>,
  signal: AbortSignal,
) {
  const dir = await mkdtemp(join(tmpdir(), "koharu-cuda-"));
  try {
    const input = join(dir, "input.f32"),
      output = join(dir, "output.bin"),
      config = join(dir, "request.json");
    const { width, height } = request;
    await transfer.run(
      { phase: "prepare", width, height, bitmap: request.bitmap, path: input },
      signal,
    );
    await writeFile(
      config,
      JSON.stringify({
        input,
        output,
        model: request.modelPath,
        wheel: session.wheel,
      }),
    );
    const result = await session.worker.run(
      ["-s", "-B", "-X", "utf8", session.script, config],
      signal,
    );
    if (result !== "ready") return;
    return (
      (await transfer.run(
        { phase: "decode", width, height, path: output },
        signal,
      )) ?? undefined
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function tryCudaLayout(
  request: NativeLayoutRequest,
  signal?: AbortSignal,
) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    request.providerPreference ||
    basename(dirname(request.modelPath)) !== "koharu-layout-rfdetr-highres-1920"
  )
    return;
  const selected = request.directMl?.computeGpuBackend;
  if (selected && selected !== "cuda" && selected !== "auto") return;
  const key = JSON.stringify([
    request.modelPath,
    request.directMl?.computeGpuIndex,
  ]);
  return enqueue(async () => {
    const running = signal ?? new AbortController().signal;
    running.throwIfAborted();
    if (failed.has(key)) return;
    try {
      if (active?.key !== key) {
        await active?.worker.dispose();
        active = await createSession(request, key, running);
      }
      if (active) return await infer(request, active, running);
    } catch (error) {
      await active?.worker.dispose();
      active = undefined;
      running.throwIfAborted();
      failed.add(key);
      logWarn("KoharuLayout CUDA unavailable; using the original CPU graph", {
        error,
      });
    }
  });
}

export function disposeCudaLayout() {
  return enqueue(async () => {
    const session = active;
    active = undefined;
    failed.clear();
    await session?.worker.dispose();
    const released = await transfer.dispose();
    return !!session || released;
  });
}
