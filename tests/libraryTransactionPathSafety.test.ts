import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

describe("library transaction path safety", () => {
  it.each([
    "",
    ".",
    "..",
    "../outside",
    "foo/../bar",
    "/absolute",
    "C:\\outside",
    "\\\\server\\share",
    "double//slash",
    "nul\u0000path",
  ])("rejects unsafe canonical path %j", async (value) => {
    const { paths } = await loadStandaloneModules();
    expect(() => paths.validateCanonicalRelativePath(value)).toThrow();
  });

  it("rejects .transactions targets, duplicate targets, and ancestor overlaps", async () => {
    const root = await createTempLibrary();
    const { transaction, paths } = await loadModules(root);
    expect(() =>
      paths.resolveLibraryRelativePath(root, ".transactions/active/x"),
    ).toThrow(/\.transactions/);

    await expect(
      transaction.runLibraryTransaction("duplicate-target", async (tx) => {
        await tx.stageJsonReplacement(join(root, "same.json"), { value: 1 });
        await tx.stageJsonReplacement(join(root, "same.json"), { value: 2 });
      }),
    ).rejects.toThrow(/중복되거나 서로 겹칩니다/);

    await expect(
      transaction.runLibraryTransaction("overlap-target", async (tx) => {
        await tx.createPublishedDirectory(join(root, "works", "work-a"));
        await tx.stageJsonReplacement(
          join(root, "works", "work-a", "work.json"),
          { value: 1 },
        );
      }),
    ).rejects.toThrow(/중복되거나 서로 겹칩니다/);
  });

  it("preserves unexpected external content and leaves the active receipt when recovery sees a hash conflict", async () => {
    const root = await createTempLibrary();
    const target = join(root, "target.json");
    await writeFile(target, "old", "utf8");
    const { transaction, recovery } = await loadModules(root);
    const restoreInjector =
      transaction.setLibraryTransactionCrashInjectorForTests((point) => {
        if (point === "after-replace-step") {
          throw new transaction.SimulatedLibraryTransactionCrash(point);
        }
      });
    try {
      await expect(
        transaction.runLibraryTransaction("recovery-conflict", async (tx) => {
          await tx.stageJsonReplacement(target, { value: "new" });
        }),
      ).rejects.toBeInstanceOf(transaction.SimulatedLibraryTransactionCrash);
    } finally {
      restoreInjector();
    }

    await writeFile(target, "external", "utf8");
    await expect(recovery.recoverLibraryTransactions()).rejects.toThrow(
      /transaction 복구에 실패했습니다/,
    );
    expect(await readFile(target, "utf8")).toBe("external");
    expect(await readdir(join(root, ".transactions", "active"))).toHaveLength(
      1,
    );
  });

  it("rejects a metadata symlink without modifying its outside sentinel", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createTempLibrary();
    const outsideRoot = await mkdtemp(join(tmpdir(), "library-path-sentinel-"));
    tempDirs.push(outsideRoot);
    const sentinel = join(outsideRoot, "sentinel.json");
    const target = join(root, "linked.json");
    await writeFile(sentinel, "outside", "utf8");
    await symlink(sentinel, target, "file");
    const { transaction } = await loadModules(root);

    await expect(
      transaction.runLibraryTransaction("symlink-target", async (tx) => {
        await tx.stageJsonReplacement(target, { value: "new" });
      }),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(sentinel, "utf8")).toBe("outside");
  });

  it("fails startup recovery if the transaction root itself is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await createTempLibrary();
    const outsideRoot = await mkdtemp(join(tmpdir(), "library-tx-root-"));
    tempDirs.push(outsideRoot);
    const transactions = join(root, ".transactions");
    await mkdir(dirname(transactions), { recursive: true });
    await symlink(outsideRoot, transactions, "dir");
    const { recovery } = await loadModules(root);

    await expect(recovery.recoverLibraryTransactions()).rejects.toThrow(
      /transaction recovery path가 directory가 아닙니다/,
    );
  });
});

async function createTempLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "library-path-safety-"));
  tempDirs.push(root);
  await mkdir(join(root, "works"), { recursive: true });
  return root;
}

async function loadStandaloneModules() {
  vi.resetModules();
  const paths =
    await import("../src/main/libraryStore/libraryTransactionPaths");
  return { paths };
}

async function loadModules(root: string) {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      libraryDir: root,
      logFile: join(root, "app.log"),
    }),
  }));
  const [transaction, recovery, paths] = await Promise.all([
    import("../src/main/libraryStore/libraryTransaction"),
    import("../src/main/libraryStore/libraryTransactionRecovery"),
    import("../src/main/libraryStore/libraryTransactionPaths"),
  ]);
  return { transaction, recovery, paths };
}
