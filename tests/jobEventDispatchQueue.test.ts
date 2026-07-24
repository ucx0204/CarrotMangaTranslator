import { describe, expect, it, vi } from "vitest";
import type { JobEvent } from "../src/shared/jobTypes";
import {
  createJobEventDispatchQueue,
  JOB_EVENT_DISPATCH_INTERVAL_MS,
  shouldCoalesceJobEvent,
} from "../src/main/jobs/jobEventDispatchQueue";

describe("job event dispatch queue", () => {
  it("collapses a progress burst into one scheduled delivery", () => {
    const dispatch = vi.fn();
    const scheduled: Array<() => void> = [];
    const cancel = vi.fn();
    const queue = createJobEventDispatchQueue(dispatch, {
      cancel,
      schedule: (callback, delayMs) => {
        expect(delayMs).toBe(JOB_EVENT_DISPATCH_INTERVAL_MS);
        scheduled.push(callback);
        return callback;
      },
    });

    for (let index = 0; index < 500; index += 1) {
      queue.enqueue(null, progressEvent(index));
    }

    expect(scheduled).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();

    scheduled[0]?.();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ progressBytes: 499 }),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("flushes pending progress before a live chapter checkpoint", () => {
    const dispatch = vi.fn();
    const cancel = vi.fn();
    const queue = createJobEventDispatchQueue(dispatch, {
      cancel,
      schedule: () => "scheduled",
    });
    const checkpoint = makeEvent({
      phase: "page_done",
      progressText: "page complete",
    });

    queue.enqueue(null, progressEvent(12));
    queue.enqueue(null, checkpoint);

    expect(dispatch.mock.calls.map((call) => call[1])).toEqual([
      progressEvent(12),
      checkpoint,
    ]);
    expect(cancel).toHaveBeenCalledWith("scheduled");
  });

  it("never delays terminal events and drops pending work on disposal", () => {
    const dispatch = vi.fn();
    const cancel = vi.fn();
    const queue = createJobEventDispatchQueue(dispatch, {
      cancel,
      schedule: () => "scheduled",
    });
    const completed = makeEvent({
      status: "completed",
      phase: "done",
      progressText: "done",
    });

    queue.enqueue(null, progressEvent(1));
    queue.enqueue(null, completed);
    queue.dispose();

    expect(dispatch.mock.calls.map((call) => call[1])).toEqual([
      progressEvent(1),
      completed,
    ]);
    expect(() => queue.enqueue(null, progressEvent(2))).toThrow(
      "Disposed job event queue",
    );
  });

  it("coalesces byte/log progress but preserves semantic and terminal events", () => {
    expect(shouldCoalesceJobEvent(progressEvent(1))).toBe(true);
    expect(
      shouldCoalesceJobEvent(
        makeEvent({
          progressMode: "log-only",
          installLogLine: "runtime output",
        }),
      ),
    ).toBe(true);
    expect(
      shouldCoalesceJobEvent(
        makeEvent({
          phase: "inpainting_done",
          progressMode: "determinate",
        }),
      ),
    ).toBe(false);
    expect(
      shouldCoalesceJobEvent(makeEvent({ status: "failed", phase: "failed" })),
    ).toBe(false);
  });
});

function progressEvent(progressBytes: number): JobEvent {
  return makeEvent({
    phase: "model_downloading",
    progressMode: "determinate",
    progressBytes,
    progressTotalBytes: 500,
  });
}

function makeEvent(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    id: "job-1",
    kind: "gemma-analysis",
    status: "running",
    progressText: "working",
    ...overrides,
  };
}
