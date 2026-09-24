import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

it("observes the native journal digest of the exact staged and committed work bytes without changing legacy calls", async () => {
  const f = await libraryImportFixture();
  try {
    const { runLibraryTransaction } =
      await import("../src/main/libraryStore/libraryTransaction");
    const { stageWorkFile } =
      await import("../src/main/libraryStore/libraryTransactionFiles");
    const { ensureExistingWork } =
      await import("../src/main/libraryStore/libraryFiles");
    const work = await ensureExistingWork("work");
    const workPath = join(f.env.libraryDir, "works", work.id, "work.json");
    const observed = vi.fn<(digest: string) => void>();
    const saved = { ...work, title: "Observed native work" };
    await runLibraryTransaction("native-work-proof", async (transaction) => {
      expect(await stageWorkFile(transaction, saved, observed)).toBeUndefined();
      const staged = await stagedWorkFile(f.env.libraryDir);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledWith(staged.sha256);
      expect(sha256(await readFile(staged.path))).toBe(staged.sha256);
      expect(JSON.parse(await readFile(staged.path, "utf8"))).toEqual(saved);
    });
    expect(sha256(await readFile(workPath))).toBe(observed.mock.calls[0][0]);
    await runLibraryTransaction(
      "native-work-without-observer",
      async (transaction) => {
        expect(
          await stageWorkFile(transaction, {
            ...saved,
            title: "Unchanged legacy staging API",
          }),
        ).toBeUndefined();
      },
    );
    expect((await ensureExistingWork("work")).title).toBe(
      "Unchanged legacy staging API",
    );
    expect(observed).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("retains native rollback when observed staged work bytes no longer match the journal", async () => {
  const f = await libraryImportFixture();
  try {
    const { runLibraryTransaction } =
      await import("../src/main/libraryStore/libraryTransaction");
    const { stageWorkFile } =
      await import("../src/main/libraryStore/libraryTransactionFiles");
    const { ensureExistingWork } =
      await import("../src/main/libraryStore/libraryFiles");
    const work = await ensureExistingWork("work");
    const workPath = join(f.env.libraryDir, "works", work.id, "work.json");
    const before = await readFile(workPath);
    const observed = vi.fn<(digest: string) => void>();
    await expect(
      runLibraryTransaction("native-work-proof-tamper", async (transaction) => {
        await stageWorkFile(
          transaction,
          { ...work, title: "Rejected native work" },
          observed,
        );
        const staged = await stagedWorkFile(f.env.libraryDir);
        expect(observed).toHaveBeenCalledTimes(1);
        expect(observed).toHaveBeenCalledWith(staged.sha256);
        await writeFile(
          staged.path,
          Buffer.concat([await readFile(staged.path), Buffer.from(" ")]),
        );
      }),
    ).rejects.toThrow("staged replacement hash");
    expect(await readFile(workPath)).toEqual(before);
    expect(
      await readdir(join(f.env.libraryDir, ".transactions", "active")),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

async function stagedWorkFile(libraryDirectory: string) {
  const { readAndValidateTransactionJournal } =
    await import("../src/main/libraryStore/libraryTransaction");
  const active = join(libraryDirectory, ".transactions", "active");
  const ids = await readdir(active);
  expect(ids).toHaveLength(1);
  const directory = join(active, ids[0]);
  const journal = await readAndValidateTransactionJournal(directory, ids[0]);
  const step = journal.steps.find(
    (item) =>
      item.kind === "replace-file" && item.target === "works/work/work.json",
  );
  if (!step || step.kind !== "replace-file")
    throw new Error("Native work replacement was not staged");
  return {
    path: join(directory, ...step.staged.split("/")),
    sha256: step.stagedSha256,
  };
}
