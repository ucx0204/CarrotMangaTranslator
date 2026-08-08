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
import type { LibraryTransactionCrashPoint } from "../src/main/libraryStore/libraryTransaction";

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

const PRE_COMMIT_CRASH_POINTS: LibraryTransactionCrashPoint[] = [
  "after-initial-journal",
  "after-seal",
  "after-publish-step",
  "after-replace-step",
  "after-retire-step",
  "before-commit-point",
];

describe("library transaction crash matrix", () => {
  it.each(PRE_COMMIT_CRASH_POINTS)(
    "recovers the complete old state after a simulated crash at %s",
    async (point) => {
      const root = await createFixture();
      const { transaction, recovery } = await loadModules(root);
      let crashed = false;
      const restoreInjector =
        transaction.setLibraryTransactionCrashInjectorForTests(
          (currentPoint) => {
            if (!crashed && currentPoint === point) {
              crashed = true;
              throw new transaction.SimulatedLibraryTransactionCrash(
                currentPoint,
              );
            }
          },
        );

      try {
        await expect(
          runFixtureTransaction(root, transaction),
        ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
      } finally {
        restoreInjector();
      }
      expect(crashed).toBe(true);

      await recovery.recoverLibraryTransactions();
      await expectOldState(root);
      expect(await transactionEntries(root, "creating")).toEqual([]);
      expect(await transactionEntries(root, "active")).toEqual([]);
      expect(await transactionEntries(root, "committed")).toEqual([]);
    },
  );

  it("keeps the complete new state after the active-to-committed commit point", async () => {
    const root = await createFixture();
    const { transaction, recovery } = await loadModules(root);
    const restoreInjector =
      transaction.setLibraryTransactionCrashInjectorForTests((point) => {
        if (point === "after-commit-point") {
          throw new transaction.SimulatedLibraryTransactionCrash(point);
        }
      });

    try {
      await expect(
        runFixtureTransaction(root, transaction),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    expect(await transactionEntries(root, "committed")).toHaveLength(1);
    await recovery.recoverLibraryTransactions();
    await expectNewState(root);
    expect(await transactionEntries(root, "active")).toEqual([]);
    expect(await transactionEntries(root, "committed")).toEqual([]);
  });

  it.each(["owner-marker-cleanup", "committed-dir-cleanup"] as const)(
    "preserves committed user data when cleanup fails at %s and startup retries cleanup",
    async (point) => {
      const root = await createFixture();
      const { transaction, recovery } = await loadModules(root);
      const restoreInjector =
        transaction.setLibraryTransactionCrashInjectorForTests(
          (currentPoint) => {
            if (currentPoint === point) {
              throw new Error(`cleanup failure at ${point}`);
            }
          },
        );
      try {
        await expect(runFixtureTransaction(root, transaction)).resolves.toBe(
          "done",
        );
      } finally {
        restoreInjector();
      }

      await expectNewState(root);
      expect(await transactionEntries(root, "committed")).toHaveLength(1);
      await recovery.recoverLibraryTransactions();
      await expectNewState(root);
      expect(await transactionEntries(root, "committed")).toEqual([]);
    },
  );
});

async function runFixtureTransaction(
  root: string,
  transaction: typeof import("../src/main/libraryStore/libraryTransaction"),
) {
  return transaction.runLibraryTransaction("crash-matrix", async (tx) => {
    const published = await tx.createPublishedDirectory(
      join(root, "published"),
    );
    await writeFile(
      join(published.stagingDirectory, "payload.txt"),
      "new-directory",
      "utf8",
    );
    await tx.stageJsonReplacement(join(root, "a.json"), { state: "new-a" });
    await tx.stageJsonReplacement(join(root, "b.json"), { state: "new-b" });
    await tx.retireFile(join(root, "retired.txt"));
    return "done";
  });
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "library-crash-matrix-"));
  tempDirs.push(root);
  await mkdir(join(root, "works"), { recursive: true });
  await writeFile(join(root, "a.json"), "old-a", "utf8");
  await writeFile(join(root, "b.json"), "old-b", "utf8");
  await writeFile(join(root, "retired.txt"), "old-retired", "utf8");
  return root;
}

async function expectOldState(root: string): Promise<void> {
  expect(await readFile(join(root, "a.json"), "utf8")).toBe("old-a");
  expect(await readFile(join(root, "b.json"), "utf8")).toBe("old-b");
  expect(await readFile(join(root, "retired.txt"), "utf8")).toBe("old-retired");
  await expect(
    readFile(join(root, "published", "payload.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectNewState(root: string): Promise<void> {
  expect(JSON.parse(await readFile(join(root, "a.json"), "utf8"))).toEqual({
    state: "new-a",
  });
  expect(JSON.parse(await readFile(join(root, "b.json"), "utf8"))).toEqual({
    state: "new-b",
  });
  await expect(readFile(join(root, "retired.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(root, "published", "payload.txt"), "utf8")).toBe(
    "new-directory",
  );
  await expect(
    readFile(join(root, "published", ".mgt-transaction-owner.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
}

async function loadModules(root: string) {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      libraryDir: root,
      logFile: join(root, "app.log"),
    }),
  }));
  const [transaction, recovery] = await Promise.all([
    import("../src/main/libraryStore/libraryTransaction"),
    import("../src/main/libraryStore/libraryTransactionRecovery"),
  ]);
  return { transaction, recovery };
}

async function transactionEntries(
  root: string,
  phase: "active" | "committed" | "creating",
): Promise<string[]> {
  return readdir(join(root, ".transactions", phase));
}
