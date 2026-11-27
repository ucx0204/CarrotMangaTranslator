import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import {
  buildPatternPageMask,
  type PatternMaskContext,
} from "./patternPageMask";

type Options = Parameters<typeof buildPatternPageMask>[0];
type Task = { kind: "pattern-page-mask"; options: Omit<Options, "signal"> };
function localBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Transfer the large mask planes once. Several block bindings can refer to
 * the very same plane and must remain aliases in the returned context. */
function transferMasks(context: PatternMaskContext) {
  const buffers = new Set<ArrayBuffer>([
    context.pageMask.buffer as ArrayBuffer,
  ]);
  for (const plane of [
    ...context.inpaintWindowMasks,
    ...context.inpaintCompositeMasks,
    ...context.inpaintWindowConstraints,
    ...context.validationWindowMasks,
  ]) {
    if (plane) buffers.add(plane.data.buffer as ArrayBuffer);
  }
  return [...buffers];
}
const task = workerData as Task | null;
if (!isMainThread && task?.kind === "pattern-page-mask" && parentPort) {
  const options = task.options;
  const context = buildPatternPageMask({
    ...options,
    bitmap: localBuffer(options.bitmap),
    sourceEvidenceBitmap:
      options.sourceEvidenceBitmap && localBuffer(options.sourceEvidenceBitmap),
  });
  parentPort.postMessage(context, transferMasks(context));
}
/** The detector and final compositor share exactly the same mask builder.
 * Keep its long synchronous raster scans off the Electron window thread. */
export async function preparePatternPageMask(
  options: Options,
): Promise<PatternMaskContext> {
  const { signal, ...input } = options;
  signal?.throwIfAborted();
  if (
    process.type !== "browser" ||
    !isMainThread ||
    !options.conditionOnTypography ||
    options.width * options.height < 500_000
  )
    return buildPatternPageMask(options);
  const job: Task = {
    kind: "pattern-page-mask",
    options: { ...input, page: { ...input.page, dataUrl: "" } },
  };
  const worker = new Worker(__filename, { workerData: job });
  return new Promise<PatternMaskContext>((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
      void worker.terminate().then(cleanup, failure);
    };
    const success = (result: PatternMaskContext) => {
      cleanup();
      resolve(result);
    };
    const failure = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exit = (code: number) =>
      failure(
        new Error(
          "원문 제거 마스크 작업이 결과를 반환하기 전에 종료됐습니다 (" +
            code +
            ").",
        ),
      );
    function cleanup() {
      signal?.removeEventListener("abort", abort);
      worker.off("message", success);
      worker.off("exit", exit);
      worker.off("error", failure);
    }
    worker.once("message", success).once("exit", exit).once("error", failure);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
