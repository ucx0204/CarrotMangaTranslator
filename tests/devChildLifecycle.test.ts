import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

type ManagedChild = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "exit" | "error", listener: () => void) => unknown;
  removeListener: (event: "exit" | "error", listener: () => void) => unknown;
};

type DevChildLifecycle = {
  isShuttingDown: () => boolean;
  shutdown: (
    exitCode: number,
    excludedChild?: ManagedChild | null,
  ) => Promise<void>;
};

const { createDevChildLifecycle } =
  require("../scripts/dev-child-lifecycle.cjs") as {
    createDevChildLifecycle: (options: {
      children: ManagedChild[];
      exit: (code: number) => void;
      gracefulShutdownMs?: number;
      forcedShutdownMs?: number;
    }) => DevChildLifecycle;
  };

class FakeChild extends EventEmitter {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(
    readonly pid: number,
    private readonly exitOnSignal: NodeJS.Signals | null = null,
  ) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (signal === this.exitOnSignal) {
      queueMicrotask(() =>
        this.finish(typeof signal === "string" ? signal : "SIGTERM"),
      );
    }
    return true;
  }

  finish(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.signalCode !== null || this.exitCode !== null) return;
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }
}

describe("development child lifecycle", () => {
  it("keeps the parent alive until every development child exits", async () => {
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const exitCodes: number[] = [];
    const lifecycle = createDevChildLifecycle({
      children: [first, second],
      exit: (code) => exitCodes.push(code),
      gracefulShutdownMs: 1_000,
    });

    const shutdown = lifecycle.shutdown(0);

    expect(lifecycle.isShuttingDown()).toBe(true);
    expect(first.signals).toEqual([undefined]);
    expect(second.signals).toEqual([undefined]);
    expect(exitCodes).toEqual([]);

    first.finish();
    await Promise.resolve();
    expect(exitCodes).toEqual([]);

    second.finish();
    await shutdown;
    expect(exitCodes).toEqual([0]);
  });

  it("forces a child that ignores the graceful signal before exiting", async () => {
    const child = new FakeChild(201, "SIGKILL");
    const exitCodes: number[] = [];
    const lifecycle = createDevChildLifecycle({
      children: [child],
      exit: (code) => exitCodes.push(code),
      gracefulShutdownMs: 10,
      forcedShutdownMs: 1_000,
    });

    await lifecycle.shutdown(7);

    expect(child.signals).toEqual([undefined, "SIGKILL"]);
    expect(exitCodes).toEqual([7]);
  });

  it("coalesces repeated shutdown requests into one exit", async () => {
    const child = new FakeChild(301, "SIGKILL");
    const exitCodes: number[] = [];
    const lifecycle = createDevChildLifecycle({
      children: [child],
      exit: (code) => exitCodes.push(code),
      gracefulShutdownMs: 10,
      forcedShutdownMs: 1_000,
    });

    const first = lifecycle.shutdown(3);
    const second = lifecycle.shutdown(9);

    expect(second).toBe(first);
    await first;
    expect(exitCodes).toEqual([3]);
  });
});
