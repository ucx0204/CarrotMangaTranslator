import { describe, expect, it, vi } from "vitest";
import {
  AppActivityBusyError,
  AppActivityGate,
} from "../src/main/appActivityGate";
import {
  AppOperationRegistry,
  runManagedAppOperation,
} from "../src/main/appOperationRegistry";
import { ActiveJobStore } from "../src/main/jobs/activeJob";

describe("AppOperationRegistry", () => {
  it("publishes visible lifecycle phases without exposing hidden operations", async () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    const events: Array<NonNullable<typeof registry.currentActivity>> = [];
    registry.subscribeActivity((event) => events.push(event));

    await expect(
      runManagedAppOperation(
        registry,
        {
          id: "preview-visible",
          kind: "library-import-preview",
          mutatesLibrary: false,
          presentation: {
            phase: "import-source-reading",
            sourceKind: "pdf",
            cancellable: true,
            progressCurrent: 0,
            progressTotal: 4,
            progressUnit: "items",
          },
        },
        async (_signal, operation) => {
          expect(registry.currentActivity).toMatchObject({
            status: "running",
            phase: "import-source-reading",
          });
          operation.updateActivity({
            phase: "import-source-validating",
            progressCurrent: 2,
            waitingForUser: true,
          });
          return "ready";
        },
      ),
    ).resolves.toBe("ready");

    expect(events.map((event) => [event.status, event.phase])).toEqual([
      ["running", "import-source-reading"],
      ["running", "import-source-validating"],
      ["completed", "import-source-validating"],
    ]);
    expect(events[1]).toMatchObject({
      progressCurrent: 2,
      progressTotal: 4,
      progressUnit: "items",
      waitingForUser: true,
    });
    expect(registry.currentActivity).toBeNull();

    const hidden = registry.begin({
      id: "hidden",
      kind: "model-test",
      mutatesLibrary: false,
    });
    hidden.finish();
    expect(events).toHaveLength(3);
  });

  it("cancels only the matching cancellable visible operation and waits for unwind", async () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    const events: string[] = [];
    registry.subscribeActivity((event) => events.push(event.status));
    let releaseUnwind!: () => void;
    const unwind = new Promise<void>((resolve) => {
      releaseUnwind = resolve;
    });

    const running = runManagedAppOperation(
      registry,
      {
        id: "cancel-me",
        kind: "library-import",
        mutatesLibrary: true,
        presentation: {
          phase: "import-library-writing",
          cancellable: true,
        },
      },
      async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              void unwind.then(() =>
                reject(new DOMException("cancelled", "AbortError")),
              ),
            { once: true },
          );
        });
      },
    );

    expect(registry.requestCancel("wrong-id")).toBe(false);
    expect(registry.requestCancel("cancel-me")).toBe(true);
    expect(registry.requestCancel("cancel-me")).toBe(false);
    expect(registry.currentActivity?.status).toBe("cancelling");
    expect(events).toEqual(["running", "cancelling"]);

    releaseUnwind();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["running", "cancelling", "cancelled"]);
  });

  it("refuses cancellation after the operation enters finalizing", () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    const lease = registry.begin({
      id: "committed",
      kind: "library-import",
      mutatesLibrary: true,
      presentation: {
        phase: "import-library-writing",
        cancellable: true,
      },
    });
    lease.updateActivity({
      phase: "import-finalizing",
      cancellable: false,
    });

    expect(registry.requestCancel("committed")).toBe(false);
    expect(lease.signal.aborted).toBe(false);
    lease.finish();
  });

  it("begins with a live signal and finishes idempotently", () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    const lease = registry.begin({
      id: "import-1",
      kind: "library-import",
      mutatesLibrary: true,
    });

    expect(lease.signal.aborted).toBe(false);
    expect(registry.current?.kind).toBe("library-import");
    lease.finish();
    lease.finish();
    expect(registry.current).toBeNull();
  });

  it("isolates activity listeners and supports unsubscribing them", () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    const listener = vi.fn(() => {
      throw new Error("presentation failed");
    });
    const unsubscribe = registry.subscribeActivity(listener);

    expect(registry.hasActive).toBe(false);
    const lease = registry.begin({
      id: "visible-operation",
      kind: "library-import-preview",
      mutatesLibrary: false,
      presentation: { phase: "import-source-reading" },
    });
    expect(registry.hasActive).toBe(true);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    lease.finish("failed");
    expect(listener).toHaveBeenCalledOnce();
    expect(registry.hasActive).toBe(false);
  });

  it("aborts the current operation and waits for finish", async () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    const lease = registry.begin({
      id: "share-1",
      kind: "work-share-import",
      mutatesLibrary: true,
    });
    let settled = false;
    const waiting = registry.abortCurrentAndWait("test").then((snapshot) => {
      settled = true;
      return snapshot;
    });

    await Promise.resolve();
    expect(lease.signal.aborted).toBe(true);
    expect(settled).toBe(false);

    lease.finish();
    await expect(waiting).resolves.toMatchObject({
      id: "share-1",
      kind: "work-share-import",
    });
    expect(settled).toBe(true);
  });

  it("preserves managed task results and errors while always finishing", async () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    await expect(
      runManagedAppOperation(
        registry,
        {
          id: "success",
          kind: "work-share-export",
          mutatesLibrary: false,
        },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
    expect(registry.current).toBeNull();

    const failure = new Error("operation failed");
    await expect(
      runManagedAppOperation(
        registry,
        {
          id: "failure",
          kind: "library-import",
          mutatesLibrary: true,
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(registry.current).toBeNull();
  });

  it("does not invoke the task when the shared gate is busy", () => {
    const gate = new AppActivityGate();
    const registry = new AppOperationRegistry(gate);
    const active = gate.acquire({
      id: "job-1",
      category: "job",
      kind: "translation",
      mutatesLibrary: true,
      blocksQuit: true,
    });
    const task = vi.fn(async () => undefined);

    expect(() =>
      runManagedAppOperation(
        registry,
        {
          id: "blocked",
          kind: "model-test",
          mutatesLibrary: false,
        },
        task,
      ),
    ).toThrow(AppActivityBusyError);
    expect(task).not.toHaveBeenCalled();
    expect(registry.current).toBeNull();
    active.release();
  });

  it("mutually excludes managed operations and ActiveJobStore jobs", () => {
    const gate = new AppActivityGate();
    const jobs = new ActiveJobStore(undefined, gate);
    const registry = new AppOperationRegistry(gate);

    const operation = registry.begin({
      id: "model-test-1",
      kind: "model-test",
      mutatesLibrary: false,
    });
    expect(() =>
      jobs.start({
        id: "translation-1",
        kind: "gemma-analysis",
        abortController: new AbortController(),
      }),
    ).toThrow("이미 실행 중인 작업이 있습니다.");
    operation.finish();

    jobs.start({
      id: "translation-2",
      kind: "gemma-analysis",
      abortController: new AbortController(),
    });
    expect(() =>
      registry.begin({
        id: "share-export-1",
        kind: "work-share-export",
        mutatesLibrary: false,
      }),
    ).toThrow(AppActivityBusyError);
    jobs.clearIfCurrent("translation-2");
  });

  it("does not let a stale finish release a successor operation", () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    const first = registry.begin({
      id: "first",
      kind: "library-import",
      mutatesLibrary: true,
    });
    first.finish();
    const second = registry.begin({
      id: "second",
      kind: "model-test",
      mutatesLibrary: false,
    });

    first.finish();
    expect(registry.current?.id).toBe("second");
    second.finish();
  });

  it("publishes only a normalized failure code for a failed visible task", async () => {
    const registry = new AppOperationRegistry(new AppActivityGate());
    const events: Array<NonNullable<typeof registry.currentActivity>> = [];
    registry.subscribeActivity((event) => events.push(event));
    const failure = Object.assign(new Error("C:/private/source.pdf failed"), {
      code: "pdf decoder: invalid input/path",
    });

    await expect(
      runManagedAppOperation(
        registry,
        {
          id: "visible-failure",
          kind: "library-import-preview",
          mutatesLibrary: false,
          presentation: { phase: "import-source-converting" },
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(events.at(-1)).toMatchObject({
      status: "failed",
      failureCode: "PDF_DECODER_INVALID_INPUT_PATH",
    });
    expect(JSON.stringify(events)).not.toContain("private/source.pdf");
  });
});
