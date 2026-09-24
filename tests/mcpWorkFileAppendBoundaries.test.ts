import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { workFileAppendFixture } from "./mcpWorkFileAppend.fixture";
import type { WorkShareImportResult } from "../src/shared/shareTypes";

it("rejects an encrypted append receipt rebound to a different destination work", async () => {
  const f = await workFileAppendFixture();
  try {
    const { command } = await f.prepareAppend();
    const receipt = await f.createWorkFile(command);
    const path = await f.storage.path(receipt.id);
    const original = await readFile(path);
    const record = (await f.storage.record(receipt.id)) as {
      receipt: { workId: string };
    };
    record.receipt.workId = "unrelated-work";
    await writeFile(path, JSON.stringify(await f.codec.seal(record)));
    await expect(
      f.invoke("carrot_get_work_file_import", { requestId: command.requestId }),
    ).rejects.toThrow();
    await writeFile(path, original);
    expect(
      await f.invoke("carrot_get_work_file_import", {
        requestId: command.requestId,
      }),
    ).toEqual(receipt);
    expect((await f.library.openChapter(receipt.chapterIds[0])).workId).toBe(
      "work",
    );
  } finally {
    await f.close();
  }
});

it("does not read or replace existing memory, masks, or unrelated chapter files when appending", async () => {
  const f = await workFileAppendFixture();
  try {
    const { command } = await f.prepareAppend();
    const directory = dirname(f.chapterPath);
    // Append treats old sidecars as opaque, including unparseable legacy memory.
    const files = [
      [
        join(directory, "memory.json"),
        Buffer.from("preserve existing manual memory bytes"),
      ],
      [join(directory, "local-mask.png"), f.bytes],
      [
        join(directory, "manual-notes.txt"),
        Buffer.from("preserve manual notes"),
      ],
    ] as const;
    for (const [path, bytes] of files) await writeFile(path, bytes);
    await f.createWorkFile(command);
    for (const [path, bytes] of files)
      expect(await readFile(path)).toEqual(bytes);
  } finally {
    await f.close();
  }
});

it("refuses native append without a publication guard before reading its package", async () => {
  const f = await workFileAppendFixture();
  try {
    const { importWorkShare } =
      await import("../src/main/library/libraryShareFacade");
    const { openSharePackageSession } =
      await import("../src/main/libraryStore/sharePackage");
    const openPackage = vi.fn(openSharePackageSession);
    const before = await f.capture();
    await expect(
      importWorkShare(
        {
          packagePath: f.packagePath,
          target: { mode: "append", workId: "work" },
          entries: [
            {
              source: "package",
              packageChapterId: "chapter",
              title: "Blocked",
            },
          ],
        },
        undefined,
        undefined,
        { openPackage },
      ),
    ).rejects.toThrow("Share append requires reviewed publication guards.");
    expect(openPackage).not.toHaveBeenCalled();
    expect(await f.capture()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("keeps guarded native append compatible with callers that omit optional mapping observers", async () => {
  const f = await workFileAppendFixture();
  try {
    const { importWorkShare } =
      await import("../src/main/library/libraryShareFacade");
    const { openSharePackageSession } =
      await import("../src/main/libraryStore/sharePackage");
    const before = await f.capture();
    const staged: WorkShareImportResult[] = [];
    const guard = vi.fn();
    const result = await importWorkShare(
      {
        packagePath: f.packagePath,
        target: { mode: "append", workId: "work" },
        entries: [
          { source: "package", packageChapterId: "chapter", title: "" },
        ],
      },
      undefined,
      {
        assertCanCommit: guard,
        stage: async (_transaction, result) => {
          staged.push(result);
        },
      },
      {
        openPackage: openSharePackageSession,
        image: {
          validateImageFile: f.validateShare,
          convertWebpToPngFile: async () => {
            throw new Error("PNG-only fixture");
          },
        },
      },
    );
    expect(guard).toHaveBeenCalled();
    expect(staged).toEqual([result]);
    expect(result.workId).toBe("work");
    expect(result.chapterIds).toHaveLength(1);
    expect(JSON.parse(await readFile(f.workPath, "utf8")).chapterOrder).toEqual(
      ["chapter", ...result.chapterIds],
    );
    const added = await f.library.openChapter(result.chapterIds[0]);
    expect(added.title).not.toBe(f.originalChapter.title);
    expect(added.title).toContain(f.originalChapter.title);
    expect(await readFile(added.pages[0].imagePath)).toEqual(
      await readFile(f.originalChapter.pages[0].imagePath),
    );
    expect(await readFile(f.chapterPath)).toEqual(before.chapter);
    expect(await readFile(f.guidePath)).toEqual(before.guide);
    expect(await readFile(f.packagePath)).toEqual(f.packageBytes);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});
