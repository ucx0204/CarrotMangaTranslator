import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

type FakeChild = EventEmitter & {
  stderr: EventEmitter;
};

type ImageRuntimeModule = {
  IMAGE_PROCESS_TERMINATION_GRACE_MS: number;
  buildImageValidationCommand: (
    filePath: string,
    options: { ffmpegPath: string; maxPixels: number; timeoutMs: number },
  ) => { executable: string; args: string[] };
  buildImageConversionCommand: (
    filePath: string,
    outputPath: string,
    options: {
      ffmpegPath: string;
      maxPixels: number;
      maxOutputBytes: number;
      timeoutMs: number;
    },
  ) => { executable: string; args: string[] };
  convertImageToPngFileWithFfmpeg: (
    filePath: string,
    outputPath: string,
    options: {
      ffmpegPath: string;
      maxPixels: number;
      maxOutputBytes: number;
      timeoutMs: number;
      abortSignal?: AbortSignal;
    },
    dependencies?: {
      spawn?: (...args: unknown[]) => FakeChild;
      terminate?: (child: FakeChild) => void;
    },
  ) => Promise<void>;
  runImageFfmpegProcess: (
    command: { executable: string; args: string[] },
    options: {
      maxPixels: number;
      timeoutMs: number;
      abortSignal?: AbortSignal;
    },
    dependencies?: {
      spawn?: (...args: unknown[]) => FakeChild;
      terminate?: (child: FakeChild) => void;
    },
  ) => Promise<void>;
};

const runtime =
  require("../src/main/runtime/assets/image-file-validation.cjs") as ImageRuntimeModule;

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("isolated image FFmpeg runtime", () => {
  it("builds validation argv with max_pixels and a null output", () => {
    const command = runtime.buildImageValidationCommand("input.png", {
      ffmpegPath: process.execPath,
      maxPixels: 120_000_000,
      timeoutMs: 120_000,
    });

    expect(command.args).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-max_pixels",
      "120000000",
      "-i",
      "input.png",
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-dn",
      "-f",
      "null",
      "-",
    ]);
  });

  it("builds file conversion argv with max_pixels, fs, no-overwrite, and no stdout pipe", () => {
    const command = runtime.buildImageConversionCommand(
      "input.webp",
      "output.png",
      {
        ffmpegPath: process.execPath,
        maxPixels: 120_000_000,
        maxOutputBytes: 512 * 1024 * 1024,
        timeoutMs: 120_000,
      },
    );

    expect(command.args).toContain("-max_pixels");
    expect(command.args).toContain("120000000");
    expect(command.args).toContain("-fs");
    expect(command.args).toContain(String(512 * 1024 * 1024));
    expect(command.args).toContain("-n");
    expect(command.args.at(-1)).toBe("output.png");
    expect(command.args).not.toContain("pipe:1");
  });

  it("spawns with shell false and ignores stdin/stdout", async () => {
    const child = makeFakeChild();
    const spawn = vi.fn((..._args: unknown[]) => child);
    const promise = runtime.runImageFfmpegProcess(
      { executable: process.execPath, args: ["--version"] },
      { maxPixels: 1, timeoutMs: 1000 },
      { spawn },
    );
    child.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
    });
  });

  it("requests process-tree termination on abort and waits for close", async () => {
    const child = makeFakeChild();
    const spawn = vi.fn(() => child);
    const terminate = vi.fn();
    const controller = new AbortController();
    const promise = runtime.runImageFfmpegProcess(
      { executable: process.execPath, args: [] },
      { maxPixels: 1, timeoutMs: 1000, abortSignal: controller.signal },
      { spawn, terminate },
    );

    controller.abort();
    expect(terminate).toHaveBeenCalledWith(child);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses an absolute timeout, terminates the child, and waits for close", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const terminate = vi.fn();
    const promise = runtime.runImageFfmpegProcess(
      { executable: process.execPath, args: [] },
      { maxPixels: 1, timeoutMs: 50 },
      { spawn: vi.fn(() => child), terminate },
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(terminate).toHaveBeenCalledWith(child);
    child.emit("close", null);
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  it("fails within the termination grace when a child never closes", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const promise = runtime.runImageFfmpegProcess(
      { executable: process.execPath, args: [] },
      { maxPixels: 1, timeoutMs: 20 },
      { spawn: vi.fn(() => child), terminate: vi.fn() },
    );

    const expectation = expect(promise).rejects.toThrow(/did not close/i);
    await vi.advanceTimersByTimeAsync(
      20 + runtime.IMAGE_PROCESS_TERMINATION_GRACE_MS,
    );
    await expectation;
  });

  it("bounds stderr diagnostics on a nonzero exit", async () => {
    const child = makeFakeChild();
    const promise = runtime.runImageFfmpegProcess(
      { executable: process.execPath, args: [] },
      { maxPixels: 1, timeoutMs: 1000 },
      { spawn: vi.fn(() => child) },
    );
    child.stderr.emit("data", "x".repeat(80_000));
    child.emit("close", 1);

    let error: (Error & { stderr?: string }) | undefined;
    try {
      await promise;
    } catch (caught) {
      error = caught as Error & { stderr?: string };
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.stderr?.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("recognizes a runtime without the required max_pixels option", async () => {
    const child = makeFakeChild();
    const promise = runtime.runImageFfmpegProcess(
      { executable: process.execPath, args: [] },
      { maxPixels: 1, timeoutMs: 1000 },
      { spawn: vi.fn(() => child) },
    );
    child.stderr.emit("data", "Unrecognized option 'max_pixels'");
    child.emit("close", 1);

    await expect(promise).rejects.toThrow(
      /does not support required -max_pixels/,
    );
  });

  it("post-stats conversion output and removes a file above the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "image-file-validation-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "output.png");
    await writeFile(outputPath, Buffer.alloc(32));
    const child = makeFakeChild();
    const promise = runtime.convertImageToPngFileWithFfmpeg(
      "input.webp",
      outputPath,
      {
        ffmpegPath: process.execPath,
        maxPixels: 120_000_000,
        maxOutputBytes: 16,
        timeoutMs: 1000,
      },
      {
        spawn: vi.fn(() => {
          queueMicrotask(() => child.emit("close", 0));
          return child;
        }),
      },
    );

    await expect(promise).rejects.toThrow(/exceeded the output limit/);
    await expect(writeFile(outputPath, "cleaned")).resolves.toBeUndefined();
  });
});

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  return child;
}
