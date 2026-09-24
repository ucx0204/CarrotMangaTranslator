import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChapterDeletionTree } from "../src/main/application/mcpChapterDeletionState";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";

let fixture: Awaited<ReturnType<typeof mcpAppEnvironment>>;
let source: ChapterDeletionTree;
let preparation: Promise<void> | undefined;
let restoration: Promise<void> | undefined;
let publishedCheck: Promise<void> | undefined;

beforeAll(() => {
  preparation = prepareWork();
  return preparation;
});
afterAll(async () => {
  // A timed-out assertion does not cancel the native transaction or its rollback.
  const operations = await Promise.allSettled([
    preparation,
    restoration,
    publishedCheck,
  ]);
  const cleanup = await Promise.allSettled([fixture?.close()]);
  const errors = [...operations, ...cleanup].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      "Work restoration fixture cleanup failed",
      {
        cause: errors[0],
      },
    );
});

describe.sequential("exact-capacity native work restoration", () => {
  it("revalidates the full staged work and its ownership marker before native publication", () => {
    restoration = revalidateStagedWork();
    return restoration;
  });
  it("preserves the published full tree and rejects the 2001st ordinary entry", () => {
    publishedCheck = verifyPublishedWork();
    return publishedCheck;
  });
});

async function prepareWork() {
  fixture = await mcpAppEnvironment();
  const { captureChapterDeletionTree } =
    await import("../src/main/mcp/mcpChapterDeletionFiles");
  const directory = join(fixture.libraryDir, "captured-work-budget");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "work.json"), "{}");
  await fillDirectories(directory);
  source = await captureChapterDeletionTree(directory, () => {}, "work.json");
}

async function revalidateStagedWork() {
  const f = fixture;
  const { captureChapterDeletionTree, captureStagedDeletionTree } =
    await import("../src/main/mcp/mcpChapterDeletionFiles");
  const { runLibraryTransaction } =
    await import("../src/main/libraryStore/libraryTransaction");
  const { withLibraryMutation } = await import("../src/main/library/lock");
  expect(source.directories.length + source.files.length).toBe(2000);
  const destination = join(f.libraryDir, "restored-work-budget");
  await withLibraryMutation(() =>
    runLibraryTransaction("exact-recovery-capacity", async (tx) => {
      const staged = await tx.createPublishedDirectory(destination);
      await writeFile(join(staged.stagingDirectory, "work.json"), "{}");
      await fillDirectories(staged.stagingDirectory);
      const verify = async () => {
        expect(
          await captureStagedDeletionTree(staged, () => {}, "work.json"),
        ).toEqual(source);
      };
      await verify();
      tx.beforePublish(verify);
      // A native marker is not silently accepted as an ordinary source file.
      await expect(
        captureChapterDeletionTree(
          staged.stagingDirectory,
          () => {},
          "work.json",
        ),
      ).rejects.toThrow();
    }),
  );
}

async function verifyPublishedWork() {
  expect(restoration).toBeDefined();
  // Never inspect an in-flight publication or conceal its original failure.
  await restoration;
  const { captureChapterDeletionTree } =
    await import("../src/main/mcp/mcpChapterDeletionFiles");
  const destination = join(fixture.libraryDir, "restored-work-budget");
  expect(
    await captureChapterDeletionTree(destination, () => {}, "work.json"),
  ).toEqual(source);
  await mkdir(join(destination, "over-capacity"));
  await expect(
    captureChapterDeletionTree(destination, () => {}, "work.json"),
  ).rejects.toThrow(/2000/);
}

async function fillDirectories(directory: string) {
  for (let start = 0; start < 1999; start += 50)
    await Promise.all(
      Array.from({ length: Math.min(50, 1999 - start) }, (_, offset) =>
        mkdir(join(directory, `empty-${start + offset}`)),
      ),
    );
}
