import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { McpImportPreviewReferenceSchema } from "../src/shared/mcpLibraryImport";

it("rejects an import caller without continuing job authorization before opening the picker or reserving work", async () => {
  const f = await libraryImportFixture();
  try {
    const before = await f.library.listLibrary();
    const current = f.current();
    await current.operations.ready();
    const tool = current.session.tools.find(
      (item) => item.name === "carrot_choose_import_files",
    );
    if (!tool) throw new Error("Native import tool was not composed");
    const { principalId, assertAuthorized, assertScopes } = f.auth();
    await expect(
      tool.invoke(
        { requestId: randomUUID(), source: "local", kind: "images" },
        { principalId, assertAuthorized, assertScopes },
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(current.operations.list(principalId, 0, 25).total).toBe(0);
    expect(f.choose).not.toHaveBeenCalled();
    expect(f.validate).not.toHaveBeenCalled();
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});

it.each(["pdf", "archive", "chapter-folder"] as const)(
  "does not prepare native runtime for %s without explicit permission",
  async (kind) => {
    const f = await libraryImportFixture();
    try {
      const selected = join(
        f.env.root,
        kind === "archive" ? "selected.rar" : "selected.pdf",
      );
      await writeFile(selected, "No native parser should inspect this input");
      f.choose.mockResolvedValueOnce([
        kind === "chapter-folder" ? dirname(selected) : selected,
      ]);
      const done = await f.settle(
        await f.invoke("carrot_choose_import_files", {
          requestId: randomUUID(),
          source: "local",
          kind,
        }),
      );
      expect(done).toMatchObject({
        status: "failed",
        error: { code: "access_denied" },
      });
      expect(done.result?.importPreview).toBeUndefined();
      expect(f.validate).not.toHaveBeenCalled();
      expect((await f.storage.index()).entries).toEqual([]);
      expect(await readFile(selected, "utf8")).toBe(
        "No native parser should inspect this input",
      );
    } finally {
      await f.close();
    }
  },
);

it("uses the existing image-folder preview and imports selected ordinary library pages", async () => {
  const f = await libraryImportFixture();
  try {
    f.choose.mockResolvedValueOnce([dirname(f.originals[0])]);
    const done = await f.settle(
      await f.invoke("carrot_choose_import_files", {
        requestId: randomUUID(),
        source: "local",
        kind: "folder",
      }),
    );
    expect(done).toMatchObject({ status: "completed" });
    const ref = McpImportPreviewReferenceSchema.parse(
      done.result?.importPreview,
    );
    const review = await f.inspect(ref);
    expect(review.pages.map((page) => page.sourceKind)).toEqual([
      "folder",
      "folder",
    ]);
    const input = await f.command(ref);
    input.chapters[0].pageIds = input.chapters[0].pageIds.slice(1);
    const receipt = await f.create(input);
    const chapter = await f.library.openChapter(receipt.chapterIds[0]);
    expect(chapter.pages).toHaveLength(1);
    expect(await readFile(chapter.pages[0].imagePath)).toEqual(
      await readFile(f.originals[1]),
    );
  } finally {
    await f.close();
  }
});

it("treats a cancelled native picker as no input and does not invent a preview or import", async () => {
  const f = await libraryImportFixture();
  try {
    f.choose.mockResolvedValueOnce([]);
    const before = await f.library.listLibrary();
    const done = await f.settle(
      await f.invoke("carrot_choose_import_files", {
        requestId: randomUUID(),
        source: "local",
        kind: "images",
      }),
    );
    expect(done).toMatchObject({
      status: "cancelled",
      result: { status: "cancelled" },
    });
    expect(done.result?.importPreview).toBeUndefined();
    expect(f.validate).not.toHaveBeenCalled();
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});

it("rejects excessive picker selections rather than silently truncating the user's chosen input", async () => {
  const f = await libraryImportFixture();
  try {
    f.choose.mockResolvedValueOnce(Array<string>(501).fill(f.originals[0]));
    const done = await f.settle(
      await f.invoke("carrot_choose_import_files", {
        requestId: randomUUID(),
        source: "local",
        kind: "images",
      }),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(done.result?.importPreview).toBeUndefined();
    expect(f.validate).not.toHaveBeenCalled();
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
