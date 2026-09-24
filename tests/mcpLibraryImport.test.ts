import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { mcpLibraryImportOutputs } from "../src/shared/mcpLibraryImport";

it("imports only reviewed pages in explicit order and reconstructs encrypted receipts without reading input again", async () => {
  const f = await libraryImportFixture();
  try {
    const before = await f.library.listLibrary();
    const sources = await Promise.all(
      f.originals.map((path) => readFile(path)),
    );
    const ref = await f.prepare();
    const input = await f.command(ref);
    input.chapters[0].pageIds.reverse();
    const receipt = await f.create(input);
    const imported = await f.library.openChapter(receipt.chapterIds[0]);
    expect(imported.pages.map((page) => page.name)).toEqual([
      "second.png",
      "first.png",
    ]);
    expect(imported.pages.every((page) => page.blocks.length === 0)).toBe(true);
    expect(await readFile(imported.pages[0].imagePath)).toEqual(sources[1]);
    expect(await readFile(imported.pages[1].imagePath)).toEqual(sources[0]);
    expect(
      (await f.library.listLibrary()).works.find((work) => work.id === "work"),
    ).toEqual(before.works[0]);
    const stored = await readFile(await f.storage.path(receipt.id), "utf8");
    expect(stored).not.toContain("Explicit new work");
    expect(await f.create(input)).toEqual(receipt);
    await f.restart();
    expect(await f.create(input)).toEqual(receipt);
    const current = mcpLibraryImportOutputs.carrot_get_import_receipt.parse(
      await f.invoke("carrot_get_import_receipt", {
        requestId: input.requestId,
      }),
    );
    expect(current.availableChapterIds).toEqual(receipt.chapterIds);
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.choose).toHaveBeenCalledOnce();
    expect(
      await Promise.all(f.originals.map((path) => readFile(path))),
    ).toEqual(sources);
    await expect(
      f.invoke("carrot_get_import_preview", {
        previewId: ref.previewId,
        snapshot: ref.snapshot,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(JSON.stringify(f.journal())).not.toMatch(
      /authorized-input|sourcePath|dataUrl/,
    );
  } finally {
    await f.close();
  }
});

it("freezes selected source bytes while preserving originals changed after preview", async () => {
  const f = await libraryImportFixture();
  try {
    const original = await readFile(f.originals[0]);
    const ref = await f.prepare();
    await writeFile(f.originals[0], "later external edit");
    const receipt = await f.create(await f.command(ref));
    const chapter = await f.library.openChapter(receipt.chapterIds[0]);
    expect(await readFile(chapter.pages[0].imagePath)).toEqual(original);
    expect(await readFile(f.originals[0], "utf8")).toBe("later external edit");
  } finally {
    await f.close();
  }
});

it("rejects changed frozen input without publishing chapters or a receipt", async () => {
  const f = await libraryImportFixture();
  try {
    const before = await f.library.listLibrary();
    const ref = await f.prepare();
    const input = await f.command(ref);
    const directory = (await readdir(join(f.env.root, "tmp"))).find((name) =>
      name.startsWith("mcp-import-"),
    );
    if (!directory) throw new Error("Missing isolated import directory");
    const path = join(f.env.root, "tmp", directory);
    await writeFile(
      join(path, (await readdir(path))[0]),
      f.bytes.subarray(0, 40),
    );
    const done = await f.settle(
      await f.invoke("carrot_import_chapters", input),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "revision_conflict" },
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.validate).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("requires the same destination snapshot and preserves later manual names", async () => {
  const f = await libraryImportFixture();
  try {
    const target = mcpLibraryImportOutputs.carrot_get_import_target.parse(
      await f.invoke("carrot_get_import_target", { workId: "work" }),
    );
    const input = await f.command(await f.prepare());
    input.target = {
      mode: "existing",
      workId: "work",
      snapshot: target.snapshot,
    };
    await f.library.renameWork("work", "Manual name after preview");
    const before = await f.library.listLibrary();
    const done = await f.settle(
      await f.invoke("carrot_import_chapters", input),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "revision_conflict" },
    });
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.validate).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("isolates owners, rejects raw paths and invalid selections, and disposes only temporary input", async () => {
  const f = await libraryImportFixture();
  try {
    const ref = await f.prepare();
    await expect(
      f.invoke(
        "carrot_get_import_preview",
        { previewId: ref.previewId, snapshot: ref.snapshot },
        f.auth("other-owner"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.invoke("carrot_choose_import_files", {
        source: "local",
        kind: "images",
        requestId: randomUUID(),
        path: f.originals[0],
      }),
    ).rejects.toThrow();
    const input = await f.command(ref);
    input.chapters[0].pageIds = [randomUUID()];
    const rejected = await f.settle(
      await f.invoke("carrot_import_chapters", input),
    );
    expect(rejected).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(
      await f.invoke("carrot_discard_import_preview", {
        previewId: ref.previewId,
        confirm: true,
      }),
    ).toMatchObject({ status: "discarded", pagesChanged: 0 });
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
    expect(f.validate).not.toHaveBeenCalled();
    expect((await f.library.listLibrary()).works).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("does not publish a preview selected after cancellation or permit automatic native parser preparation", async () => {
  const f = await libraryImportFixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.choose.mockImplementationOnce(async () => {
      await waiting;
      return f.originals;
    });
    const accepted = (await f.invoke("carrot_choose_import_files", {
      source: "local",
      kind: "images",
      requestId: randomUUID(),
    })) as { jobId: string };
    await f.current().operations.cancel(accepted.jobId, "import-owner");
    release();
    expect(await f.settle(accepted)).toMatchObject({ status: "cancelled" });
    expect(f.validate).not.toHaveBeenCalled();
    const denied = await f.settle(
      await f.invoke("carrot_choose_import_files", {
        source: "local",
        kind: "pdf",
        requestId: randomUUID(),
      }),
    );
    expect(denied.status).toBe("failed");
    expect((await f.library.listLibrary()).works).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
});
