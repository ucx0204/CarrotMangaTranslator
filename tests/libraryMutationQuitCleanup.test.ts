import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("library mutation quit coordination", () => {
  it("waits for active and already-queued mutation leases while rejecting mutations admitted after close", async () => {
    const { lock, coordinator } = await loadModules();
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondEntered = deferred<void>();
    const releaseSecond = deferred<void>();

    const first = lock.withLibraryMutation(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstEntered.promise;

    const second = lock.withLibraryMutation(async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
      return "second";
    });
    expect(
      coordinator.libraryMutationCoordinator.getActiveCountForTests(),
    ).toBe(2);

    coordinator.libraryMutationCoordinator.closeToNewMutations();
    expect(() => lock.withLibraryMutation(async () => "late")).toThrow(
      /종료 중/,
    );

    let idleResolved = false;
    const idle = coordinator.libraryMutationCoordinator
      .waitForIdle()
      .then(() => {
        idleResolved = true;
      });
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await secondEntered.promise;
    expect(idleResolved).toBe(false);

    releaseSecond.resolve();
    await expect(second).resolves.toBe("second");
    await idle;
    expect(idleResolved).toBe(true);
    expect(
      coordinator.libraryMutationCoordinator.getActiveCountForTests(),
    ).toBe(0);
  });

  it("makes navigation and mutations fail closed after rollback recovery is required", async () => {
    const { lock, coordinator } = await loadModules();
    coordinator.libraryMutationCoordinator.markRecoveryRequired(
      new Error("rollback failed"),
    );

    expect(() => lock.withLibraryNavigationRead(async () => "read")).toThrow(
      /transaction 복구가 필요합니다/,
    );
    expect(() => lock.withLibraryMutation(async () => "write")).toThrow(
      /transaction 복구가 필요합니다/,
    );
  });
});

async function loadModules() {
  vi.resetModules();
  const [lock, coordinator] = await Promise.all([
    import("../src/main/library/lock"),
    import("../src/main/libraryStore/libraryMutationCoordinator"),
  ]);
  return { lock, coordinator };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
