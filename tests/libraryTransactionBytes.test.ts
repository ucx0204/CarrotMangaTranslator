import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";

it("stages exact binary bytes without JSON conversion and preserves the original JSON serialization", async () => {
  const f = await libraryImportFixture();
  try {
    const { runLibraryTransaction } =
      await import("../src/main/libraryStore/libraryTransaction");
    const image = join(f.env.libraryDir, "native-bytes.bin");
    const metadata = join(f.env.libraryDir, "native-json.json");
    const bytes = Buffer.from([0, 255, 128, 13, 10, 0]);
    await runLibraryTransaction("native-bytes", async (tx) => {
      await tx.stageBytesReplacement(image, bytes);
      await tx.stageJsonReplacement(metadata, { label: "한글" });
      bytes.fill(7);
      await expect(readFile(image)).rejects.toMatchObject({ code: "ENOENT" });
    });
    expect(await readFile(image)).toEqual(
      Buffer.from([0, 255, 128, 13, 10, 0]),
    );
    expect(await readFile(metadata, "utf8")).toBe(
      JSON.stringify({ label: "한글" }, null, 2) + "\n",
    );
    await expect(
      runLibraryTransaction("duplicate-target", async (tx) => {
        await tx.stageBytesReplacement(image, Buffer.from("first"));
        await tx.stageBytesReplacement(image, Buffer.from("second"));
      }),
    ).rejects.toThrow();
    expect(await readFile(image)).toEqual(
      Buffer.from([0, 255, 128, 13, 10, 0]),
    );
  } finally {
    await f.close();
  }
});

it.each(["after-replace-step", "after-commit-point"] as const)(
  "recovers native binary replacement and creation together after %s",
  async (point) => {
    const f = await libraryImportFixture();
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    const { recoverLibraryTransactions } =
      await import("../src/main/libraryStore/libraryTransactionRecovery");
    let release: (() => void) | undefined;
    try {
      const existing = join(f.env.libraryDir, "existing.bin"),
        added = join(f.env.libraryDir, "added.bin");
      await writeFile(existing, Buffer.from([255, 0, 255]));
      let injected = false;
      release = tx.setLibraryTransactionCrashInjectorForTests((actual) => {
        if (!injected && actual === point) {
          injected = true;
          throw new tx.SimulatedLibraryTransactionCrash(actual);
        }
      });
      await expect(
        tx.runLibraryTransaction("binary-crash", async (transaction) => {
          await transaction.stageBytesReplacement(
            existing,
            Buffer.from([1, 2]),
          );
          await transaction.stageBytesReplacement(added, Buffer.from([3, 4]));
        }),
      ).rejects.toBeInstanceOf(tx.SimulatedLibraryTransactionCrash);
      release();
      release = undefined;
      expect(injected).toBe(true);
      await recoverLibraryTransactions();
      if (point === "after-commit-point") {
        expect(await readFile(existing)).toEqual(Buffer.from([1, 2]));
        expect(await readFile(added)).toEqual(Buffer.from([3, 4]));
      } else {
        expect(await readFile(existing)).toEqual(Buffer.from([255, 0, 255]));
        await expect(readFile(added)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      release?.();
      await f.close();
    }
  },
);
