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
        undefined,
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

it("rolls back staged files when the master's publication owner refuses entry", async () => {
  const environment = await mcpAppEnvironment();
  const path = join(environment.libraryDir, "publisher.json");
  const transaction =
    await import("../src/main/libraryStore/libraryTransaction");
  try {
    await mkdir(environment.libraryDir, { recursive: true });
    await writeFile(path, "before");
    await expect(
      transaction.runLibraryTransaction(
        "publisher-refused",
        async (tx) => {
          await tx.stageJsonReplacement(path, { value: "unpublished" });
        },
        async () => {
          throw new Error("publication owner cancelled");
        },
      ),
    ).rejects.toThrow("publication owner cancelled");
    expect(await readFile(path, "utf8")).toBe("before");
    expect(
      await readdir(join(environment.libraryDir, ".transactions", "active")),
    ).toEqual([]);
  } finally {
    await environment.close();
  }
});
it("honors the committed result even if the publication wrapper fails after success", async () => {
  const environment = await mcpAppEnvironment();
  const path = join(environment.libraryDir, "publisher.json");
  const transaction =
    await import("../src/main/libraryStore/libraryTransaction");
  try {
    await mkdir(environment.libraryDir, { recursive: true });
    await writeFile(path, "before");
    const result = await transaction.runLibraryTransaction(
      "publisher-post-commit",
      async (tx) => {
        await tx.stageJsonReplacement(path, { value: "committed" });
        return "saved";
      },
      async (publish) => {
        await publish();
        throw new Error("publisher failed after durable commit");
      },
    );
    expect(result).toBe("saved");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      value: "committed",
    });
  } finally {
    await environment.close();
  }
});
it("rechecks remote authority after pre-publication hooks under the same publisher", async () => {
  const environment = await mcpAppEnvironment();
  const path = join(environment.libraryDir, "publisher.json");
  const transaction =
    await import("../src/main/libraryStore/libraryTransaction");
  let authorized = true;
  const events: string[] = [];
  try {
    await mkdir(environment.libraryDir, { recursive: true });
    await writeFile(path, "before");
    await expect(
      transaction.runLibraryTransaction(
        "publisher-revoked",
        async (tx) => {
          await tx.stageJsonReplacement(path, { value: "rejected" });
          tx.beforePublish(async () => {
            events.push("prepare");
            authorized = false;
          });
        },
        async (publish) => {
          events.push("owner");
          return publish();
        },
        () => {
          events.push("authority");
          if (!authorized) throw new Error("authority revoked");
        },
      ),
    ).rejects.toThrow("authority revoked");
    expect(events).toEqual(["owner", "prepare", "authority"]);
    expect(await readFile(path, "utf8")).toBe("before");
  } finally {
    await environment.close();
  }
});
