import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("library transaction startup recovery", () => {
  it("removes unpublished creating transactions without touching library data", async () => {
    const root = await createTempLibrary();
    const target = join(root, "stable.json");
    await writeFile(target, "stable", "utf8");
    const { transaction, recovery } = await loadModules(root);
    const restoreInjector =
      transaction.setLibraryTransactionCrashInjectorForTests((point) => {
        if (point === "after-initial-journal") {
          throw new transaction.SimulatedLibraryTransactionCrash(point);
        }
      });
    try {
      await expect(
        transaction.runLibraryTransaction(
          "creating-crash",
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    expect(await readdir(join(root, ".transactions", "creating"))).toHaveLength(
      1,
    );
    const result = await recovery.recoverLibraryTransactions();
    expect(result.creatingRemoved).toBe(1);
    expect(await readFile(target, "utf8")).toBe("stable");
  });

  it("fails closed on a corrupt active journal and keeps the receipt", async () => {
    const root = await createTempLibrary();
    const activeId = "11111111-1111-4111-8111-111111111111";
    const activeRoot = join(root, ".transactions", "active", activeId);
    await mkdir(activeRoot, { recursive: true });
    await mkdir(join(root, ".transactions", "creating"), { recursive: true });
    await mkdir(join(root, ".transactions", "committed"), { recursive: true });
    await writeFile(join(activeRoot, "journal.json"), "{broken-json", "utf8");
    const { recovery, coordinator } = await loadModules(root);

    await expect(recovery.recoverLibraryTransactions()).rejects.toThrow(
      /transaction 복구에 실패했습니다/,
    );
    expect(await readdir(join(root, ".transactions", "active"))).toEqual([
      activeId,
    ]);
    expect(coordinator.libraryMutationCoordinator.getStateForTests()).toBe(
      "recovery-required",
    );
  });

  it("never rolls back a committed transaction and only retries its cleanup", async () => {
    const root = await createTempLibrary();
    const target = join(root, "state.json");
    await writeFile(target, "old", "utf8");
    const { transaction, recovery } = await loadModules(root);
    const restoreInjector =
      transaction.setLibraryTransactionCrashInjectorForTests((point) => {
        if (point === "after-commit-point") {
          throw new transaction.SimulatedLibraryTransactionCrash(point);
        }
      });
    try {
      await expect(
        transaction.runLibraryTransaction("committed-recovery", async (tx) => {
          await tx.stageJsonReplacement(target, { state: "new" });
        }),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      state: "new",
    });
    const result = await recovery.recoverLibraryTransactions();
    expect(result.committedCleaned).toBe(1);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      state: "new",
    });
  });
});

async function createTempLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "library-transaction-recovery-"));
  tempDirs.push(root);
  await mkdir(join(root, "works"), { recursive: true });
  return root;
}

async function loadModules(root: string) {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      libraryDir: root,
      logFile: join(root, "app.log"),
    }),
  }));
  const [transaction, recovery, coordinator] = await Promise.all([
    import("../src/main/libraryStore/libraryTransaction"),
    import("../src/main/libraryStore/libraryTransactionRecovery"),
    import("../src/main/libraryStore/libraryMutationCoordinator"),
  ]);
  return { transaction, recovery, coordinator };
}
