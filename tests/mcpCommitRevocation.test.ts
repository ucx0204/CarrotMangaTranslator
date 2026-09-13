import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { it, expect } from "vitest";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";

it("rolls back actual staged and published files if authorization is revoked before durable commit", async () => {
  const environment = await mcpAppEnvironment();
  const root = environment.libraryDir;
  await mkdir(join(root, "works"), { recursive: true });
  await writeFile(join(root, "a.json"), "old-a", "utf8");
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
    await environment.close();
  }
});
