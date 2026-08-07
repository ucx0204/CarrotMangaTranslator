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
});
