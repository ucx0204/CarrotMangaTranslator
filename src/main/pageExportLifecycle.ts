import { spawn } from "node:child_process";
import { observeProcessErrors } from "./runtimeSupport/observeProcessErrors";

const PAGE_EXPORT_STITCH_TIMEOUT_MS = 10 * 60_000;
const MAX_FFMPEG_ERROR_CHARS = 16_384;

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal?.reason);
    const timer = setTimeout(() => fail(new Error(message)), timeoutMs);
    // Observe late Electron replies even after cancellation has won the race.
    void operation.then((value) => {
      cleanup();
      resolve(value);
    }, fail);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const operationSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  return withTimeout(
    Promise.resolve().then(() => {
      throwIfAborted(operationSignal);
      return operation(operationSignal);
    }),
    timeoutMs,
    message,
    signal,
  ).catch((error: unknown) => {
    controller.abort(error);
    throw error;
  });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

export function throwPageExportCleanupError(
  renderFailure: { error: unknown } | null,
  cleanupErrors: unknown[],
): void {
  if (cleanupErrors.length === 0) return;
  if (renderFailure) {
    const { error: renderError } = renderFailure;
    throw new AggregateError(
      [renderError, ...cleanupErrors],
      `PNG export failed: ${errorMessage(renderError)}. Window cleanup also failed: ${cleanupErrors.map(errorMessage).join("; ")}`,
      { cause: renderError },
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(
    cleanupErrors,
    `PNG export window cleanup failed: ${cleanupErrors.map(errorMessage).join("; ")}`,
    { cause: cleanupErrors[0] },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runPageExportFfmpeg(
  executable: string,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    // Wait for close after killing: the stitcher must stop writing before the
    // render session removes its tiles and releases the page's edit lease.
    const abort = () => {
      child.kill("SIGKILL");
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    let errorText = "";
    let spawnError: Error | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PAGE_EXPORT_STITCH_TIMEOUT_MS);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (errorText.length < MAX_FFMPEG_ERROR_CHARS) {
        errorText = `${errorText}${chunk}`.slice(0, MAX_FFMPEG_ERROR_CHARS);
      }
    });
    const onError = (error: Error): void => {
      if (spawnError) return;
      spawnError = error;
      cleanup();
      reject(error);
      child.kill("SIGKILL");
    };
    observeProcessErrors(child, onError);
    child.once("close", (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (timedOut) {
        reject(new Error("Page export tile stitching timed out."));
        return;
      }
      if (spawnError) return;
      if (code !== 0) {
        reject(
          new Error(
            `Page export tile stitching failed (${code ?? "unknown"}): ${errorText.trim()}`,
          ),
        );
        return;
      }
      resolve();
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
