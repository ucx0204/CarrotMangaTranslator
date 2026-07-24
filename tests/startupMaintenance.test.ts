import { describe, expect, it, vi } from "vitest";
import {
  scheduleStartupMaintenance,
  STARTUP_MAINTENANCE_DELAY_MS,
} from "../src/main/startupMaintenance";

describe("deferred startup maintenance", () => {
  it("does not run filesystem maintenance on the startup call stack", async () => {
    const scheduled: ScheduledTask[] = [];
    const run = vi.fn(async () => undefined);
    scheduleStartupMaintenance({
      isBusy: () => false,
      reportError: vi.fn(),
      run,
      runtime: createRuntime(scheduled),
    });

    expect(run).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(STARTUP_MAINTENANCE_DELAY_MS);

    scheduled[0]?.callback();
    await Promise.resolve();

    expect(run).toHaveBeenCalledOnce();
  });

  it("waits for active jobs instead of contending with translation", async () => {
    const scheduled: ScheduledTask[] = [];
    let busy = true;
    const run = vi.fn(async () => undefined);
    scheduleStartupMaintenance({
      isBusy: () => busy,
      reportError: vi.fn(),
      run,
      runtime: createRuntime(scheduled),
    });

    scheduled.shift()?.callback();
    expect(run).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    busy = false;
    scheduled.shift()?.callback();
    await Promise.resolve();

    expect(run).toHaveBeenCalledOnce();
  });

  it("cancels pending maintenance and reports task failures", async () => {
    const scheduled: ScheduledTask[] = [];
    const cancelHandle = vi.fn();
    const reportError = vi.fn();
    const failure = new Error("cleanup failed");
    const runtime = createRuntime(scheduled, cancelHandle);
    const cancel = scheduleStartupMaintenance({
      isBusy: () => false,
      reportError,
      run: async () => {
        throw failure;
      },
      runtime,
    });

    const firstHandle = scheduled[0];
    cancel();
    expect(cancelHandle).toHaveBeenCalledWith(firstHandle);

    const scheduledAfterCancel: ScheduledTask[] = [];
    scheduleStartupMaintenance({
      isBusy: () => false,
      reportError,
      run: async () => {
        throw failure;
      },
      runtime: createRuntime(scheduledAfterCancel),
    });
    scheduledAfterCancel[0]?.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith(failure);
  });
});

type ScheduledTask = {
  callback: () => void;
  delayMs: number;
};

function createRuntime(
  scheduled: ScheduledTask[],
  cancel = vi.fn(),
): {
  cancel: (handle: unknown) => void;
  schedule: (callback: () => void, delayMs: number) => ScheduledTask;
} {
  return {
    cancel,
    schedule: (callback, delayMs) => {
      const task = { callback, delayMs };
      scheduled.push(task);
      return task;
    },
  };
}
