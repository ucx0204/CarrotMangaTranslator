import { createRequire } from "node:module";
import { expect, it } from "vitest";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import { workFileFixture } from "./mcpWorkFileImport.fixture";

const Zip = createRequire(import.meta.url)("adm-zip") as new (
  bytes: Buffer,
) => {
  readAsText: (path: string) => string;
  updateFile: (path: string, bytes: Buffer) => void;
  toBuffer: () => Buffer;
};

it("rejects duplicate page identities before review can promise more pages than the native importer preserves", async () => {
  const f = await workFileFixture();
  try {
    const before = await f.library.listLibrary();
    const zip = new Zip(f.packageBytes);
    const path = "chapters/chapter/chapter.json";
    const chapter: LibraryChapter = JSON.parse(zip.readAsText(path));
    expect(chapter.pages).toHaveLength(2);
    chapter.pages[1].id = chapter.pages[0].id;
    chapter.pageOrder = [chapter.pages[0].id];
    zip.updateFile(path, Buffer.from(JSON.stringify(chapter)));
    const uploaded = await f.upload(zip.toBuffer());
    await expect(f.review(uploaded.uploadId)).rejects.toThrow();
    expect(f.validateShare).not.toHaveBeenCalled();
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps legacy incomplete page order without dropping unique pages or changing the source", async () => {
  const f = await workFileFixture();
  try {
    const zip = new Zip(f.packageBytes);
    const path = "chapters/chapter/chapter.json";
    const chapter: LibraryChapter = JSON.parse(zip.readAsText(path));
    chapter.pageOrder = [chapter.pages[1].id];
    zip.updateFile(path, Buffer.from(JSON.stringify(chapter)));
    const uploaded = await f.upload(zip.toBuffer());
    const review = await f.review(uploaded.uploadId);
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile({
      ...command,
      uploadId: uploaded.uploadId,
      snapshot: review.snapshot,
    });
    const imported = await f.library.openChapter(receipt.chapterIds[0]);
    expect(receipt.pageCount).toBe(2);
    expect(imported.pages.map((page) => page.name)).toEqual([
      chapter.pages[1].name,
      chapter.pages[0].name,
    ]);
    expect(await f.library.openChapter("chapter")).toMatchObject({
      pageOrder: f.originalChapter.pageOrder,
    });
  } finally {
    await f.close();
  }
});
