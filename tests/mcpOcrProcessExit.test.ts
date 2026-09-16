import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

type Runner = {
  runCommand: (
    command: { executable: string; args: string[] },
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      timeoutMessage?: string;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
};
const modulePath =
  require.resolve("../src/main/runtime/transport/shell-command.cjs");
const original = require.cache[modulePath];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (original) require.cache[modulePath] = original;
  else delete require.cache[modulePath];
});
function fixture() {
  const child = Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
  });
  // Only the external subprocess boundary is replaced. No model process exists.
  const kill = vi.spyOn(child, "kill").mockReturnValue(false);
  vi.spyOn(require("node:child_process"), "spawn").mockReturnValue(child);
  delete require.cache[modulePath];
  const runner = require(modulePath) as Runner;
  return { child, kill, runner };
}

it.each(["cancel", "timeout", "stdout", "child"] as const)(
  "holds an OCR command until actual close after %s, including failed kill acknowledgement",
  async (event) => {
    vi.useFakeTimers();
    const f = fixture();
    const abort = new AbortController();
    const failure = new Error("native stream failure");
    let settled = false;
    const work = f.runner.runCommand(
      { executable: "fixture-ocr", args: [] },
      {
        signal: abort.signal,
        timeoutMs: 100,
        timeoutMessage: "fixture timeout",
      },
    );
    const result = work.then(
      (value) => {
        settled = true;
        return { status: "fulfilled", value };
      },
      (reason: unknown) => {
        settled = true;
        return { status: "rejected", reason };
      },
    );
    try {
      if (event === "cancel") abort.abort();
      if (event === "timeout") await vi.advanceTimersByTimeAsync(100);
      if (event === "stdout") f.child.stdout.emit("error", failure);
      if (event === "child") f.child.emit("error", failure);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.kill).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      f.child.emit("error", new Error("late process error"));
      expect(f.kill).toHaveBeenCalledOnce();
      f.child.emit("close", 0, null);
      const outcome = await result;
      expect(outcome).toMatchObject({
        status: "rejected",
        reason:
          event === "cancel"
            ? { name: "AbortError" }
            : {
                message:
                  event === "timeout" ? "fixture timeout" : failure.message,
              },
      });
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.child.emit("close", 1, null);
      await result;
    }
  },
);

it("preserves the cancellation reason if the native child closes synchronously from kill", async () => {
  const f = fixture();
  f.kill.mockImplementationOnce(() => {
    f.child.emit("close", 0, null);
    return true;
  });
  const abort = new AbortController();
  const work = f.runner.runCommand(
    { executable: "fixture-ocr", args: [] },
    { signal: abort.signal },
  );
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  await rejected;
  expect(f.kill).toHaveBeenCalledOnce();
});
