import { expect, it, vi } from "vitest";
import { QwenControlSession } from "../src/main/inpainting/qwenControlSession";
import type { QwenGpuStatus } from "../src/main/inpainting/qwenGpuBudget";
import { waitForQwenGpu } from "../src/main/inpainting/qwenGpuBudget";

const worker = `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const job = JSON.parse(line);
  if (job.type === "shutdown") return process.exit(0);
  if (job.config === "pending") return;
  const ok = job.config !== "oom";
  console.log(JSON.stringify({id:job.id, ok, error:ok ? undefined : "out of memory"}));
});
`;

it("rechecks a lost memory reading with no active model before resuming", async () => {
  const probe = vi
    .fn<() => Promise<QwenGpuStatus>>()
    .mockRejectedValueOnce(new Error("driver busy"))
    .mockResolvedValue("ready");
  const progress = vi.fn();
  await waitForQwenGpu(probe, new AbortController().signal, progress);
  expect(progress.mock.calls.flat()).toEqual(["telemetry", "ready"]);
  const wait = vi.fn(async () => {});
  const monitor = vi
    .fn<
      (
        pid: number,
        closed: Promise<unknown>,
        stop: () => void,
      ) => Promise<QwenGpuStatus>
    >()
    .mockRejectedValueOnce(new Error("memory counter unavailable"))
    .mockImplementation(async (_pid, closed) => {
      await closed;
      return "ready";
    });
  const session = new QwenControlSession({
    executable: process.execPath,
    env: process.env,
    platformGpu: { wait, monitor },
  });
  const signal = new AbortController().signal;
  try {
    expect(await session.run(["-e", worker, "--", "pending"], signal)).toBe(
      "telemetry",
    );
    expect(await session.run(["-e", worker, "--", "retry"], signal)).toBe(
      "ready",
    );
    expect(wait).toHaveBeenCalledTimes(2);
  } finally {
    await session.dispose();
  }
});

it("yields a resident GPU between crops and reacquires after OOM and cancellation", async () => {
  let yieldGpu: (() => void) | undefined;
  const pids: number[] = [];
  const wait = vi.fn(async () => {});
  const monitor = (pid: number, closed: Promise<unknown>, stop: () => void) => {
    pids.push(pid);
    return new Promise<QwenGpuStatus>((resolve) => {
      closed.then(() => resolve("ready"));
      yieldGpu = () => {
        resolve("inference");
        stop();
      };
    });
  };
  const session = new QwenControlSession({
    executable: process.execPath,
    env: process.env,
    platformGpu: { wait, monitor },
  });
  const run = (config: string, signal = new AbortController().signal) =>
    session.run(["-e", worker, "--", config], signal);
  try {
    await run("first");
    await run("second");
    expect(pids).toHaveLength(1);
    yieldGpu?.();
    await run("after-private-inference");
    expect(pids).toHaveLength(2);
    expect(await run("oom")).toBe("memory");
    const abort = new AbortController();
    const pending = run("pending", abort.signal);
    await vi.waitFor(() => expect(pids).toHaveLength(3));
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(await run("after-cancel")).toBe("ready");
    expect(wait).toHaveBeenCalledTimes(4);
  } finally {
    await session.dispose();
  }
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
});
