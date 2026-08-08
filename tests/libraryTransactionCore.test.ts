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

describe("library transaction core", () => {
  it("commits publish, replace, and retire steps as one durable transaction", async () => {
    const root = await createTempLibrary();
    await writeFile(join(root, "a.json"), "old-a", "utf8");
    await writeFile(join(root, "old.txt"), "retire-me", "utf8");
    const { transaction } = await loadTransactionModules(root);

    const result = await transaction.runLibraryTransaction(
      "core-success",
      async (tx) => {
        const published = await tx.createPublishedDirectory(
          join(root, "published"),
        );
        await writeFile(
          join(published.stagingDirectory, "payload.txt"),
          "published",
          "utf8",
        );
        await tx.stageJsonReplacement(join(root, "a.json"), { value: "new-a" });
        await tx.retireFile(join(root, "old.txt"));
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(JSON.parse(await readFile(join(root, "a.json"), "utf8"))).toEqual({
      value: "new-a",
    });
    expect(await readFile(join(root, "published", "payload.txt"), "utf8")).toBe(
      "published",
    );
    await expect(readFile(join(root, "old.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(root, "published", ".mgt-transaction-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await transactionEntries(root, "active")).toEqual([]);
    expect(await transactionEntries(root, "committed")).toEqual([]);
  });

  it("removes unsealed staging and preserves final files when the callback fails", async () => {
    const root = await createTempLibrary();
    await writeFile(join(root, "a.json"), "old-a", "utf8");
    const { transaction } = await loadTransactionModules(root);

    await expect(
      transaction.runLibraryTransaction("callback-failure", async (tx) => {
        await tx.stageJsonReplacement(join(root, "a.json"), { value: "new-a" });
        throw new Error("stop before seal");
      }),
    ).rejects.toThrow("stop before seal");

    expect(await readFile(join(root, "a.json"), "utf8")).toBe("old-a");
    expect(await transactionEntries(root, "active")).toEqual([]);
  });

  it("fails closed on an external hash conflict and poisons further library mutations if rollback cannot complete", async () => {
    const root = await createTempLibrary();
    await writeFile(join(root, "a.json"), "old-a", "utf8");
    await writeFile(join(root, "b.json"), "old-b", "utf8");
    const { transaction, coordinator } = await loadTransactionModules(root);

    let thrown: unknown;
    try {
      await transaction.runLibraryTransaction(
        "rollback-conflict",
        async (tx) => {
          await tx.stageJsonReplacement(join(root, "a.json"), {
            value: "new-a",
          });
          await tx.stageJsonReplacement(join(root, "b.json"), {
            value: "new-b",
          });
          await writeFile(join(root, "b.json"), "external-content", "utf8");
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(coordinator.libraryMutationCoordinator.getStateForTests()).toBe(
      "recovery-required",
    );
    expect(await readFile(join(root, "b.json"), "utf8")).toBe(
      "external-content",
    );
    expect(await transactionEntries(root, "active")).toHaveLength(1);
    expect(() => coordinator.libraryMutationCoordinator.begin()).toThrow(
      /transaction 복구가 필요합니다/,
    );
  });

  it("keeps a committed receipt for startup cleanup without turning cleanup failure into an operation failure", async () => {
    const root = await createTempLibrary();
    await writeFile(join(root, "a.json"), "old-a", "utf8");
    const { transaction, recovery } = await loadTransactionModules(root);
    const restoreInjector =
      transaction.setLibraryTransactionCrashInjectorForTests((point) => {
        if (point === "committed-dir-cleanup") {
          throw new Error("cleanup unavailable");
        }
      });

    try {
      await expect(
        transaction.runLibraryTransaction("cleanup-warning", async (tx) => {
          await tx.stageJsonReplacement(join(root, "a.json"), {
            value: "new-a",
          });
        }),
      ).resolves.toBeUndefined();
    } finally {
      restoreInjector();
    }

    expect(JSON.parse(await readFile(join(root, "a.json"), "utf8"))).toEqual({
      value: "new-a",
    });
    expect(await transactionEntries(root, "committed")).toHaveLength(1);

    const recovered = await recovery.recoverLibraryTransactions();
    expect(recovered.committedCleaned).toBe(1);
    expect(await transactionEntries(root, "committed")).toEqual([]);
  });
});

async function createTempLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "library-transaction-core-"));
  tempDirs.push(root);
  await mkdir(join(root, "works"), { recursive: true });
  return root;
}

async function loadTransactionModules(root: string) {
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

async function transactionEntries(
  root: string,
  phase: "active" | "committed" | "creating",
): Promise<string[]> {
  return readdir(join(root, ".transactions", phase));
}
