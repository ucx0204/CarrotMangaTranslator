import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

describe("library transaction publication barrier", () => {
  it("allows old-state navigation during long staging and blocks navigation during the short commit window", async () => {
    const root = await mkdtemp(join(tmpdir(), "library-publication-"));
    tempDirs.push(root);
    await mkdir(join(root, "works"), { recursive: true });
    const target = join(root, "state.json");
    await writeFile(target, "old", "utf8");
    const { transaction, lock } = await loadModules(root);

    const staged = deferred<void>();
    const allowCallbackToFinish = deferred<void>();
    const commitEntered = deferred<void>();
    const allowCommitToFinish = deferred<void>();
    const restoreInjector =
      transaction.setLibraryTransactionCrashInjectorForTests(async (point) => {
        if (point === "before-commit-point") {
          commitEntered.resolve();
          await allowCommitToFinish.promise;
        }
      });

    try {
      const mutation = transaction.runLibraryTransaction(
        "publication-barrier",
        async (tx) => {
          await tx.stageJsonReplacement(target, { state: "new" });
          staged.resolve();
          await allowCallbackToFinish.promise;
        },
      );

      await staged.promise;
      const duringStaging = await lock.withLibraryNavigationRead(() =>
        readFile(target, "utf8"),
      );
      expect(duringStaging).toBe("old");

      allowCallbackToFinish.resolve();
      await commitEntered.promise;
      let navigationResolved = false;
      const duringCommit = lock
        .withLibraryNavigationRead(() => readFile(target, "utf8"))
        .then((value) => {
          navigationResolved = true;
          return value;
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(navigationResolved).toBe(false);

      allowCommitToFinish.resolve();
      await mutation;
      expect(JSON.parse(await duringCommit)).toEqual({ state: "new" });
      expect(navigationResolved).toBe(true);
    } finally {
      restoreInjector();
    }
  });
});

async function loadModules(root: string) {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      libraryDir: root,
      logFile: join(root, "app.log"),
    }),
  }));
  const [transaction, lock] = await Promise.all([
    import("../src/main/libraryStore/libraryTransaction"),
    import("../src/main/library/lock"),
  ]);
  return { transaction, lock };
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
