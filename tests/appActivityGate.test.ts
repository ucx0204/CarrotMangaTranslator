import { describe, expect, it } from "vitest";
import {
  AppActivityBusyError,
  AppActivityClosedError,
  AppActivityGate,
  type AppActivityCategory,
} from "../src/main/appActivityGate";
import { isAbortErrorLike } from "../src/main/abortSignal";

describe("AppActivityGate", () => {
  it("acquires and releases an activity", () => {
    const gate = new AppActivityGate();
    const category: AppActivityCategory = "job";
    const lease = gate.acquire({
      id: "job-1",
      category,
      kind: "translation",
      mutatesLibrary: true,
      blocksQuit: true,
      startedAt: 123,
    });

    expect(gate.current).toEqual({
      id: "job-1",
      category: "job",
      kind: "translation",
      mutatesLibrary: true,
      blocksQuit: true,
      startedAt: 123,
    });
    expect(gate.isUnavailable).toBe(true);

    lease.release();
    expect(gate.current).toBeNull();
    expect(gate.isUnavailable).toBe(false);
  });

  it("recognizes standard abort errors through the shared helper", () => {
    expect(isAbortErrorLike(new DOMException("cancelled", "AbortError"))).toBe(
      true,
    );
    expect(isAbortErrorLike(new Error("failure"))).toBe(false);
  });

  it("mutually excludes job and operation categories", () => {
    const gate = new AppActivityGate();
    const job = gate.acquire({
      id: "job-1",
      category: "job",
      kind: "translation",
      mutatesLibrary: true,
      blocksQuit: true,
    });

    expect(() =>
      gate.acquire({
        id: "operation-1",
        category: "operation",
        kind: "model-test",
        mutatesLibrary: false,
        blocksQuit: true,
      }),
    ).toThrow(AppActivityBusyError);

    job.release();
    const operation = gate.acquire({
      id: "operation-1",
      category: "operation",
      kind: "model-test",
      mutatesLibrary: false,
      blocksQuit: true,
    });
    expect(gate.current?.category).toBe("operation");
    operation.release();
  });

  it("does not let duplicate release clear a successor activity", () => {
    const gate = new AppActivityGate();
    const oldLease = gate.acquire({
      id: "old",
      category: "job",
      kind: "translation",
      mutatesLibrary: true,
      blocksQuit: true,
    });
    oldLease.release();

    const successor = gate.acquire({
      id: "new",
      category: "operation",
      kind: "library-import",
      mutatesLibrary: true,
      blocksQuit: true,
    });
    oldLease.release();

    expect(gate.current?.id).toBe("new");
    successor.release();
  });

  it("closes intake idempotently while allowing the current lease to release", () => {
    const gate = new AppActivityGate();
    const lease = gate.acquire({
      id: "active",
      category: "operation",
      kind: "work-share-export",
      mutatesLibrary: false,
      blocksQuit: true,
    });

    gate.closeToNewActivities();
    gate.closeToNewActivities();
    expect(gate.isUnavailable).toBe(true);
    expect(() =>
      gate.acquire({
        id: "late",
        category: "job",
        kind: "page-export",
        mutatesLibrary: false,
        blocksQuit: true,
      }),
    ).toThrow(AppActivityClosedError);

    lease.release();
    expect(gate.current).toBeNull();
    expect(gate.isUnavailable).toBe(true);
  });

  it("returns descriptor copies instead of exposing internal metadata", () => {
    const gate = new AppActivityGate();
    const lease = gate.acquire({
      id: "safe-id",
      category: "operation",
      kind: "model-test",
      mutatesLibrary: false,
      blocksQuit: true,
      startedAt: 456,
    });

    (lease.descriptor as { id: string }).id = "mutated";
    const snapshot = gate.current;
    expect(snapshot?.id).toBe("safe-id");
    if (snapshot) {
      (snapshot as { kind: string }).kind = "mutated-kind";
    }
    expect(gate.current?.kind).toBe("model-test");
    lease.release();
  });
});
