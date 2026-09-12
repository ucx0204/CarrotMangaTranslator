import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";

it("rolls back actual staged and published files if authorization is revoked before durable commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-revoked-commit-"));
  await mkdir(join(root, "works"));
  await writeFile(join(root, "a.json"), "old-a", "utf8");
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({ libraryDir: root, logFile: join(root, "app.log") }),
  }));
  const transaction =
    await import("../src/main/libraryStore/libraryTransaction");
  let authorized = true;
  const restore = transaction.setLibraryTransactionCrashInjectorForTests(
    (point) => {
      if (point === "before-commit-point") authorized = false;
    },
  );
  try {
    await expect(
      transaction.runLibraryTransaction(
        "revoked-commit",
        async (tx) => {
          await tx.stageJsonReplacement(join(root, "a.json"), {
            value: "not-authorized",
          });
        },
        () => {
          if (!authorized) throw new Error("permission revoked");
        },
      ),
    ).rejects.toThrow("permission revoked");
    expect(await readFile(join(root, "a.json"), "utf8")).toBe("old-a");
    expect(await readdir(join(root, ".transactions", "active"))).toEqual([]);
  } finally {
    restore();
    vi.doUnmock("../src/main/appPaths");
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  }
});
