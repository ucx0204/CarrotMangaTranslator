import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { createJobEventEmitter } from "../src/main/jobs/jobEvents";
import type { JobEvent } from "../src/shared/jobTypes";
import { JOB_EVENT_DISPATCH_INTERVAL_MS } from "../src/main/jobs/jobEventDispatchQueue";

const writeLog = vi.fn();
const validateEvent = vi.fn();
const emitJobEvent = createJobEventEmitter({ validateEvent, writeLog });

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("main-process job event throughput", () => {
  it("keeps the active state current while bounding validation, logging, and IPC", () => {
    vi.useFakeTimers();
    const jobs = new ActiveJobStore();
    jobs.start({
      id: "job-1",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });
    const send = vi.fn();
    const mainWindow = { webContents: { send } };

    for (let index = 0; index < 500; index += 1) {
      emitJobEvent(jobs, mainWindow, progressEvent(index));
    }

    expect(jobs.current?.lastEvent).toMatchObject({ progressBytes: 499 });
    expect(send).not.toHaveBeenCalled();
    expect(writeLog).not.toHaveBeenCalled();

    vi.advanceTimersByTime(JOB_EVENT_DISPATCH_INTERVAL_MS);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toMatchObject({ progressBytes: 499 });
    expect(writeLog).toHaveBeenCalledOnce();
    expect(validateEvent).toHaveBeenCalledOnce();

    const completed = makeEvent({
      status: "completed",
      phase: "done",
      progressText: "done",
    });
    emitJobEvent(jobs, mainWindow, completed);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1]).toEqual(completed);
    expect(writeLog).toHaveBeenCalledTimes(2);
    expect(validateEvent).toHaveBeenCalledTimes(2);

    emitJobEvent(jobs, mainWindow, progressEvent(999));
    vi.runAllTimers();

    expect(jobs.current?.lastEvent).toEqual(completed);
    expect(send).toHaveBeenCalledTimes(2);
    expect(writeLog).toHaveBeenCalledTimes(2);
    expect(validateEvent).toHaveBeenCalledTimes(2);

    jobs.clearIfCurrent("job-1");
    emitJobEvent(jobs, mainWindow, progressEvent(1000));
    vi.runAllTimers();

    expect(send).toHaveBeenCalledTimes(2);
    expect(writeLog).toHaveBeenCalledTimes(2);
    expect(validateEvent).toHaveBeenCalledTimes(2);
  });

  it("contains a renderer teardown race without failing the active job", () => {
    const jobs = new ActiveJobStore();
    jobs.start({
      id: "job-1",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });
    const sendFailure = new Error("webContents was destroyed");
    const mainWindow = {
      webContents: {
        send: vi.fn(() => {
          throw sendFailure;
        }),
      },
    };
    const checkpoint = makeEvent({
      phase: "page_done",
      progressText: "page complete",
    });

    expect(() => emitJobEvent(jobs, mainWindow, checkpoint)).not.toThrow();

    expect(jobs.current?.lastEvent).toEqual(checkpoint);
    expect(writeLog).toHaveBeenNthCalledWith(
      2,
      "warn",
      "Failed to deliver job event to renderer",
      expect.objectContaining({ error: sendFailure, jobId: "job-1" }),
    );
  });

  it("surfaces an invalid event contract instead of treating it as a renderer race", () => {
    const jobs = new ActiveJobStore();
    jobs.start({
      id: "job-1",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });
    const validationFailure = new Error("invalid job event");
    const send = vi.fn();
    const invalidEventEmitter = createJobEventEmitter({
      validateEvent: () => {
        throw validationFailure;
      },
      writeLog,
    });

    expect(() =>
      invalidEventEmitter(
        jobs,
        { webContents: { send } },
        makeEvent({ phase: "page_done" }),
      ),
    ).toThrow(validationFailure);
    expect(send).not.toHaveBeenCalled();
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
