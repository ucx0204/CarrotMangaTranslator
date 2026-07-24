import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLoggerRuntime,
  type LogOutputStream,
} from "../src/main/loggerRuntime";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("logger runtime output boundaries", () => {
  it("contains emitted stream errors and disables only that destination", () => {
    const dir = mkdtempSync(join(tmpdir(), "manga-logger-event-"));
    tempDirs.push(dir);
    const logPath = join(dir, "logs", "app.log");
    const stdout = new FakeOutputStream();
    const stderr = new FakeOutputStream();
    const runtime = createRuntime(logPath, stdout, stderr);

    runtime.writeLog("info", "before emitted failure");
    stdout.emit("error", new Error("stdout event failure"));
    runtime.writeLog("info", "after emitted failure");
    runtime.writeLog("warn", "stderr remains available");

    expect(stdout.writes).toHaveLength(1);
    expect(stderr.writes).toHaveLength(1);
    expect(stderr.writes[0]).toContain("stderr remains available");
    const file = readFileSync(logPath, "utf8");
    expect(
      file.match(/Console log transport disabled \(stdout\)/g),
    ).toHaveLength(1);
    expect(file).toContain("stdout event failure");
    expect(file).toContain("after emitted failure");
  });

  it("disables a broken stdout once while file and stderr logging continue", () => {
    const dir = mkdtempSync(join(tmpdir(), "manga-logger-runtime-"));
    tempDirs.push(dir);
    const logPath = join(dir, "logs", "app.log");
    const stdout = new FakeOutputStream();
    const stderr = new FakeOutputStream();
    const runtime = createLoggerRuntime({
      resolveLogPath: () => logPath,
      serializeDetail: (detail) =>
        detail instanceof Error
          ? JSON.stringify({ message: detail.message })
          : JSON.stringify(detail),
      stdout,
      stderr,
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });

    runtime.writeLog("info", "before pipe failure");
    stdout.failLastWrite(new Error("EPIPE: broken pipe, write"));
    runtime.writeLog("info", "after pipe failure");
    runtime.writeLog("error", "stderr remains available");

    expect(stdout.writes).toHaveLength(1);
    expect(stderr.writes).toHaveLength(1);
    expect(stderr.writes[0]).toContain("stderr remains available");
    const file = readFileSync(logPath, "utf8");
    expect(file).toContain("before pipe failure");
    expect(file).toContain("Console log transport disabled (stdout)");
    expect(file).toContain("EPIPE: broken pipe, write");
    expect(file).toContain("after pipe failure");
    expect(file).toContain("stderr remains available");
  });

  it("contains synchronous stream failures without recursive writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "manga-logger-throw-"));
    tempDirs.push(dir);
    const logPath = join(dir, "logs", "app.log");
    const stdout = new FakeOutputStream();
    stdout.nextFailure = new Error("stdout closed");
    const runtime = createLoggerRuntime({
      resolveLogPath: () => logPath,
      serializeDetail: (detail) =>
        JSON.stringify({
          message: detail instanceof Error ? detail.message : String(detail),
        }),
      stdout,
      stderr: new FakeOutputStream(),
    });

    expect(() => runtime.writeLog("info", "still persisted")).not.toThrow();
    expect(() => runtime.writeLog("info", "second persisted")).not.toThrow();

    const file = readFileSync(logPath, "utf8");
    expect(file.match(/Console log transport disabled/g)).toHaveLength(1);
    expect(file).toContain("still persisted");
    expect(file).toContain("second persisted");
  });

  it("shares one physical error listener across repeated module imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manga-logger-listeners-"));
    tempDirs.push(dir);
    const logPath = join(dir, "logs", "app.log");
    const stdout = new FakeOutputStream();
    const stderr = new FakeOutputStream();
    const runtimes: Array<ReturnType<typeof createLoggerRuntime>> = [];

    for (let index = 0; index < 16; index += 1) {
      vi.resetModules();
      const freshModule = await import("../src/main/loggerRuntime");
      runtimes.push(
        freshModule.createLoggerRuntime({
          resolveLogPath: () => logPath,
          serializeDetail,
          stdout,
          stderr,
        }),
      );
    }

    expect(stdout.listenerCount("error")).toBe(1);
    expect(stderr.listenerCount("error")).toBe(1);
    runtimes.at(-1)?.writeLog("info", "latest runtime remains usable");
    expect(readFileSync(logPath, "utf8")).toContain(
      "latest runtime remains usable",
    );
  });

  it("rotates only a bounded tail from an oversized startup log", () => {
    const dir = mkdtempSync(join(tmpdir(), "manga-logger-bounded-"));
    tempDirs.push(dir);
    const logPath = join(dir, "logs", "app.log");
    const stdout = new FakeOutputStream();
    const stderr = new FakeOutputStream();
    const runtime = createLoggerRuntime({
      resolveLogPath: () => logPath,
      serializeDetail,
      stdout,
      stderr,
      maxRotatedLogBytes: 256,
      retainedLogBytes: 96,
    });
    runtime.writeLog("info", "old prefix ".repeat(80));
    runtime.writeLog("error", "recent failure marker");

    runtime.resetAppLog();

    const previous = readFileSync(join(dir, "logs", "previous.log"), "utf8");
    expect(previous).toContain("tail from oversized app.log");
    expect(previous).toContain("recent failure marker");
    expect(Buffer.byteLength(previous)).toBeLessThan(180);
    expect(readFileSync(logPath, "utf8")).toBe("");
  });
});

function createRuntime(
  logPath: string,
  stdout: LogOutputStream,
  stderr: LogOutputStream,
): ReturnType<typeof createLoggerRuntime> {
  return createLoggerRuntime({
    resolveLogPath: () => logPath,
    serializeDetail,
    stdout,
    stderr,
  });
}

function serializeDetail(detail: unknown): string {
  return JSON.stringify({
    message: detail instanceof Error ? detail.message : String(detail),
  });
}

class FakeOutputStream extends EventEmitter implements LogOutputStream {
  readonly writes: string[] = [];
  nextFailure: Error | null = null;
  private lastCallback: ((error?: Error | null) => void) | null = null;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    if (this.nextFailure) {
      const error = this.nextFailure;
      this.nextFailure = null;
      throw error;
    }
    this.writes.push(chunk);
    this.lastCallback = callback ?? null;
    return true;
  }

  failLastWrite(error: Error): void {
    this.lastCallback?.(error);
  }
}
