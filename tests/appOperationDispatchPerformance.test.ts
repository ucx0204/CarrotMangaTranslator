import { afterEach, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";

afterEach(() => vi.useRealTimers());

it("measures management progress delivery while retaining the latest snapshot", () => {
  vi.useFakeTimers();
  const registry = new AppOperationRegistry(new AppActivityGate());
  const delivered = vi.fn();
  registry.subscribeActivity(delivered);
  const lease = registry.begin({
    id: "benchmark",
    kind: "library-import-preview",
    mutatesLibrary: false,
    presentation: {
      phase: "import-source-reading",
      progressCurrent: 0,
      progressTotal: 1000,
    },
  });
  delivered.mockClear();
  for (let i = 1; i <= 1000; i++) lease.updateActivity({ progressCurrent: i });
  expect(registry.currentActivity?.progressCurrent).toBe(1000);
  vi.advanceTimersByTime(32);
  process.stdout.write(
    `management progress: 1000 updates, ${delivered.mock.calls.length} deliveries` +
      "\n",
  );
  expect(delivered).toHaveBeenCalledOnce();
  lease.finish();
  expect(delivered.mock.lastCall?.[0]).toMatchObject({
    status: "completed",
    progressCurrent: 1000,
  });
});

it.each(["completed", "failed", "cancelled"] as const)(
  "delivers %s immediately and cannot replay queued progress over a reused id",
  (status) => {
    vi.useFakeTimers();
    const registry = new AppOperationRegistry(new AppActivityGate());
    const delivered = vi.fn();
    registry.subscribeActivity(delivered);
    const options = {
      id: "reuse",
      kind: "library-import-preview" as const,
      mutatesLibrary: false,
      presentation: { phase: "import-source-reading" as const },
    };
    const first = registry.begin(options);
    first.updateActivity({ progressCurrent: 10 });
    first.finish(status);
    expect(delivered.mock.lastCall?.[0]).toMatchObject({
      status,
      progressCurrent: 10,
    });
    const next = registry.begin(options);
    delivered.mockClear();
    first.updateActivity({ progressCurrent: 99 });
    first.finish();
    vi.runAllTimers();
    expect(delivered).not.toHaveBeenCalled();
    expect(registry.hasActive).toBe(true);
    next.finish();
  },
);

it("keeps concurrent progress independent and publishes phase/cancel transitions immediately", () => {
  vi.useFakeTimers();
  const registry = new AppOperationRegistry(new AppActivityGate());
  const delivered = vi.fn();
  registry.subscribeActivity(delivered);
  const first = registry.begin({
    id: "first",
    kind: "library-import-preview",
    mutatesLibrary: false,
    resources: [],
    presentation: { phase: "import-source-reading", cancellable: true },
  });
  const second = registry.begin({
    id: "second",
    kind: "library-import-preview",
    mutatesLibrary: false,
    resources: [],
    presentation: { phase: "import-source-reading" },
  });
  delivered.mockClear();
  first.updateActivity({ progressCurrent: 4 });
  second.updateActivity({ progressCurrent: 8 });
  first.updateActivity({
    phase: "import-source-validating",
    waitingForUser: true,
  });
  expect(delivered).toHaveBeenCalledOnce();
  expect(delivered.mock.lastCall?.[0]).toMatchObject({
    id: "first",
    progressCurrent: 4,
    waitingForUser: true,
  });
  expect(registry.requestCancel("first")).toBe(true);
  expect(delivered.mock.lastCall?.[0].status).toBe("cancelling");
  vi.advanceTimersByTime(32);
  expect(delivered.mock.lastCall?.[0]).toMatchObject({
    id: "second",
    progressCurrent: 8,
  });
  expect(delivered).toHaveBeenCalledTimes(3);
  first.finish();
  second.finish();
  expect(vi.getTimerCount()).toBe(0);
});
