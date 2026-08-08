import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("library recovery-required queue safety", () => {
  it("does not execute a mutation queued before a rollback poison", async () => {
    const { lock, coordinator } = await loadModules();
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondOperation = vi.fn(async () => "second");

    const first = lock.withLibraryMutation(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstEntered.promise;

    const second = lock.withLibraryMutation(secondOperation);
    expect(
      coordinator.libraryMutationCoordinator.getActiveCountForTests(),
    ).toBe(2);

    const rollbackFailure = new Error("rollback failed");
    coordinator.libraryMutationCoordinator.markRecoveryRequired(
      rollbackFailure,
    );

    const idle = coordinator.libraryMutationCoordinator.waitForIdle();
    releaseFirst.resolve();

    await expect(first).resolves.toBe("first");
    await expect(second).rejects.toThrow(/transaction 복구가 필요합니다/);
    expect(secondOperation).not.toHaveBeenCalled();

    await idle;
    expect(
      coordinator.libraryMutationCoordinator.getActiveCountForTests(),
    ).toBe(0);
  });

  it("does not execute a stable read queued before a rollback poison", async () => {
    const { lock, coordinator } = await loadModules();
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const readOperation = vi.fn(async () => "read");

    const first = lock.withLibraryMutation(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return "first";
    });
    await firstEntered.promise;

    const read = lock.withLibraryRead(readOperation);
    coordinator.libraryMutationCoordinator.markRecoveryRequired(
      new Error("rollback failed"),
    );

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first");
    await expect(read).rejects.toThrow(/transaction 복구가 필요합니다/);
    expect(readOperation).not.toHaveBeenCalled();
  });

  it("does not execute a navigation read queued before a rollback poison", async () => {
    const { lock, coordinator, publicationLock } = await loadModules();
    const publicationEntered = deferred<void>();
    const releasePublication = deferred<void>();
    const navigationOperation = vi.fn(async () => "navigation");

    const publication = publicationLock.withLibraryPublicationWrite(
      async () => {
        publicationEntered.resolve();
        await releasePublication.promise;
      },
    );
    await publicationEntered.promise;

    const navigation = lock.withLibraryNavigationRead(navigationOperation);
    coordinator.libraryMutationCoordinator.markRecoveryRequired(
      new Error("rollback failed"),
    );

    releasePublication.resolve();
    await publication;
    await expect(navigation).rejects.toThrow(/transaction 복구가 필요합니다/);
    expect(navigationOperation).not.toHaveBeenCalled();
  });

  it("keeps the first recovery-required cause", async () => {
    const { coordinator } = await loadModules();
    const first = new Error("first rollback failure");
    const second = new Error("secondary failure");

    coordinator.libraryMutationCoordinator.markRecoveryRequired(first);
    coordinator.libraryMutationCoordinator.markRecoveryRequired(second);

    let thrown: unknown;
    try {
      coordinator.libraryMutationCoordinator.assertReadable();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ cause: first });
  });
});

async function loadModules() {
  vi.resetModules();
  const [lock, coordinator, publicationLock] = await Promise.all([
    import("../src/main/library/lock"),
    import("../src/main/libraryStore/libraryMutationCoordinator"),
    import("../src/main/libraryStore/libraryPublicationLock"),
  ]);
  return { lock, coordinator, publicationLock };
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
