/* eslint-disable max-lines -- ZIP stream lifecycle, abort cleanup, and atomic commit stay co-located for auditability */
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yazl from "yazl";
import {
  createAbortError,
  isAbortErrorLike,
  throwIfAborted,
} from "../abortSignal";
import { renameWithTransientRetry } from "./storage";
import {
  createZipEntryBudgetTracker,
  MAX_SHARE_JSON_BYTES,
  normalizeShareRelativePath,
  type ZipEntryBudgetTracker,
} from "./zipSafety";

export type StreamingShareArchiveWriter = {
  addJson: (archivePath: string, value: unknown) => Promise<void>;
  addFile: (
    archivePath: string,
    source: {
      path: string;
      size: number;
    },
  ) => Promise<void>;
};

type LazyReadStreamCallback = (
  error: unknown,
  readStream: NodeJS.ReadableStream,
) => void;

type ZipFileLike = {
  outputStream: NodeJS.ReadableStream;
  addReadStreamLazy: (
    metadataPath: string,
    options: Partial<yazl.ReadStreamOptions>,
    getReadStreamFunction: (callback: LazyReadStreamCallback) => void,
  ) => void;
  end: () => void;
  on: (event: "error", listener: (error: unknown) => void) => ZipFileLike;
};

export type ShareStreamingZipRuntime = {
  createZipFile: () => ZipFileLike;
  createInputStream: (path: string, signal?: AbortSignal) => Readable;
  createOutputStream: (path: string) => WriteStream;
  mkdir: typeof mkdir;
  rm: typeof rm;
  syncFile: (path: string) => Promise<void>;
  renameWithRetry: (
    sourcePath: string,
    destinationPath: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  createId: () => string;
};

const productionRuntime: ShareStreamingZipRuntime = {
  createZipFile: () => new yazl.ZipFile(),
  createInputStream: (path, signal) =>
    createReadStream(path, {
      highWaterMark: 64 * 1024,
      ...(signal ? { signal } : {}),
    }),
  createOutputStream: (path) =>
    createWriteStream(path, {
      flags: "wx",
      mode: 0o600,
    }),
  mkdir,
  rm,
  syncFile: async (path) => {
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  renameWithRetry: renameWithTransientRetry,
  createId: randomUUID,
};

class SequentialShareZipWriter implements StreamingShareArchiveWriter {
  private readonly zipFile: ZipFileLike;
  private readonly outputStream: WriteStream;
  private readonly outputPipeline: Promise<void>;
  private readonly budget: ZipEntryBudgetTracker;
  private readonly archivePaths = new Set<string>();
  private activeInput: Readable | null = null;
  private fatalError: Error | null = null;
  private readonly fatalPromise: Promise<never>;
  private rejectFatal: (error: Error) => void = () => undefined;
  private finalized = false;
  private stopped = false;
  private readonly abortListener?: () => void;

  constructor(
    private readonly options: {
      tempPath: string;
      archiveDate: Date;
      signal?: AbortSignal;
      runtime: ShareStreamingZipRuntime;
    },
  ) {
    this.zipFile = options.runtime.createZipFile();
    this.outputStream = options.runtime.createOutputStream(options.tempPath);
    this.budget = createZipEntryBudgetTracker("공유 파일");
    this.fatalPromise = new Promise<never>((_resolve, reject) => {
      this.rejectFatal = reject;
    });
    void this.fatalPromise.catch((_error) => {
      // error-policy-allow: fatalPromise only wakes waiters; fatalError owns the diagnostic.
    });

    this.zipFile.on("error", (error) => {
      this.recordFatal(toError(error));
    });

    const zipOutput = this.zipFile.outputStream as Readable;
    this.outputPipeline = options.signal
      ? pipeline(zipOutput, this.outputStream, { signal: options.signal })
      : pipeline(zipOutput, this.outputStream);
    void this.outputPipeline.catch((error: unknown) => {
      this.recordFatal(toError(error));
    });

    if (options.signal) {
      this.abortListener = () => {
        this.recordFatal(getAbortReason(options.signal));
      };
      options.signal.addEventListener("abort", this.abortListener, {
        once: true,
      });
    }
  }

  async addJson(archivePath: string, value: unknown): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (bytes.byteLength > MAX_SHARE_JSON_BYTES) {
      throw new Error(`${archivePath} 파일이 너무 큽니다.`);
    }
    await this.addLazyStream({
      archivePath,
      size: bytes.byteLength,
      createStream: () => Readable.from([bytes]),
    });
  }

  async addFile(
    archivePath: string,
    source: { path: string; size: number },
  ): Promise<void> {
    await this.addLazyStream({
      archivePath,
      size: source.size,
      createStream: () =>
        this.options.runtime.createInputStream(
          source.path,
          this.options.signal,
        ),
    });
  }

  async finalize(): Promise<void> {
    this.assertWritable();
    throwIfAborted(this.options.signal);
    this.finalized = true;
    this.zipFile.end();
    await this.outputPipeline;
    if (this.fatalError) {
      throw this.fatalError;
    }
    this.stopped = true;
    this.detachAbortListener();
  }

  async abort(cause: unknown): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.recordFatal(toError(cause));
    await this.outputPipeline.catch((_error) => {
      // error-policy-allow: recordFatal already owns the pipeline failure during abort.
    });
    this.stopped = true;
    this.detachAbortListener();
  }

  private async addLazyStream({
    archivePath,
    size,
    createStream,
  }: {
    archivePath: string;
    size: number;
    createStream: () => Readable;
  }): Promise<void> {
    this.assertWritable();
    throwIfAborted(this.options.signal);
    const safePath = this.registerEntry(archivePath, size);

    let resolveConsumed: () => void = () => undefined;
    let rejectConsumed: (error: Error) => void = () => undefined;
    const consumed = new Promise<void>((resolve, reject) => {
      resolveConsumed = resolve;
      rejectConsumed = reject;
    });

    try {
      this.zipFile.addReadStreamLazy(
        safePath,
        {
          size,
          compress: false,
          mtime: this.options.archiveDate,
          mode: 0o100644,
        },
        (callback) =>
          this.provideLazyInput({
            safePath,
            createStream,
            resolveConsumed,
            rejectConsumed,
            callback,
          }),
      );
    } catch (error) {
      const normalized = toError(error);
      this.recordFatal(normalized);
      throw normalized;
    }

    await Promise.race([consumed, this.fatalPromise]);
    throwIfAborted(this.options.signal);
  }

  private provideLazyInput({
    safePath,
    createStream,
    resolveConsumed,
    rejectConsumed,
    callback,
  }: {
    safePath: string;
    createStream: () => Readable;
    resolveConsumed: () => void;
    rejectConsumed: (error: Error) => void;
    callback: LazyReadStreamCallback;
  }): void {
    if (this.fatalError) {
      rejectConsumed(this.fatalError);
      callback(this.fatalError, Readable.from([]));
      return;
    }

    try {
      throwIfAborted(this.options.signal);
      const input = createStream();
      this.activeInput = input;
      this.observeInputCompletion(
        input,
        safePath,
        resolveConsumed,
        rejectConsumed,
      );
      callback(null, input);
    } catch (error) {
      const normalized = toError(error);
      rejectConsumed(normalized);
      this.recordFatal(normalized);
      callback(normalized, Readable.from([]));
    }
  }

  private observeInputCompletion(
    input: Readable,
    safePath: string,
    resolveConsumed: () => void,
    rejectConsumed: (error: Error) => void,
  ): void {
    let ended = false;
    let settled = false;
    const finish = () => {
      if (this.activeInput === input) {
        this.activeInput = null;
      }
    };
    const resolveOnce = () => {
      if (!settled) {
        settled = true;
        resolveConsumed();
      }
    };
    const rejectOnce = (error: Error) => {
      if (!settled) {
        settled = true;
        rejectConsumed(error);
      }
    };

    input.once("end", () => {
      ended = true;
      finish();
      resolveOnce();
    });
    input.once("error", (error) => {
      const normalized = toError(error);
      finish();
      rejectOnce(normalized);
      this.recordFatal(normalized);
    });
    input.once("close", () => {
      if (ended) {
        return;
      }
      finish();
      const error =
        this.fatalError ??
        new Error(`ZIP 입력 stream이 완료 전에 닫혔습니다: ${safePath}`);
      rejectOnce(error);
      this.recordFatal(error);
    });
  }

  private registerEntry(archivePath: string, size: number): string {
    const safePath = normalizeShareRelativePath(
      archivePath,
      "공유 파일에 안전하지 않은 경로가 있습니다.",
    );
    if (this.archivePaths.has(safePath)) {
      throw new Error(`공유 파일에 중복 항목이 있습니다: ${safePath}`);
    }
    this.archivePaths.add(safePath);
    this.budget.addEntry(size, safePath);
    return safePath;
  }

  private assertWritable(): void {
    if (this.fatalError) {
      throw this.fatalError;
    }
    if (this.finalized || this.stopped) {
      throw new Error("공유 ZIP writer가 이미 종료되었습니다.");
    }
  }

  private recordFatal(error: Error): void {
    if (this.fatalError || this.stopped) {
      return;
    }
    this.fatalError = error;
    this.rejectFatal(error);
    this.activeInput?.destroy(error);
    const zipOutput = this.zipFile.outputStream as Readable;
    zipOutput.destroy(error);
    this.outputStream.destroy(error);
  }

  private detachAbortListener(): void {
    if (this.abortListener && this.options.signal) {
      this.options.signal.removeEventListener("abort", this.abortListener);
    }
  }
}

export async function writeAtomicStreamingShareArchive<TResult>(
  options: {
    outputPath: string;
    archiveDate: Date;
    signal?: AbortSignal;
  },
  writeEntries: (writer: StreamingShareArchiveWriter) => Promise<TResult>,
  runtime: ShareStreamingZipRuntime = productionRuntime,
): Promise<TResult> {
  throwIfAborted(options.signal);
  await runtime.mkdir(dirname(options.outputPath), { recursive: true });
  throwIfAborted(options.signal);

  const tempPath = createShareTempPath(options.outputPath, runtime.createId);
  let writer: SequentialShareZipWriter | null = null;

  try {
    writer = new SequentialShareZipWriter({
      tempPath,
      archiveDate: options.archiveDate,
      signal: options.signal,
      runtime,
    });
    const result = await writeEntries(writer);
    throwIfAborted(options.signal);
    await writer.finalize();
    throwIfAborted(options.signal);
    await runtime.syncFile(tempPath);
    throwIfAborted(options.signal);
    await runtime.renameWithRetry(tempPath, options.outputPath, options.signal);
    return result;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (writer) {
      try {
        await writer.abort(error);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await runtime.rm(tempPath, { force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }

    if (cleanupErrors.length === 0) {
      throw error;
    }
    if (isAbortErrorLike(error)) {
      attachCleanupErrors(error, cleanupErrors);
      throw error;
    }
    throw new AggregateError(
      [error, ...cleanupErrors],
      "공유 파일 내보내기와 임시 파일 정리에 모두 실패했습니다.",
      { cause: error },
    );
  }
}

function createShareTempPath(
  outputPath: string,
  createId: () => string = randomUUID,
): string {
  return join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${createId()}.tmp`,
  );
}

function getAbortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : createAbortError();
}

function attachCleanupErrors(error: unknown, cleanupErrors: unknown[]): void {
  if (error instanceof Error) {
    Object.assign(error, { cleanupErrors });
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
