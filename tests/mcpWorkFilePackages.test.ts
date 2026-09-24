import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import { workFileFixture } from "./mcpWorkFileImport.fixture";

const Zip = createRequire(import.meta.url)("adm-zip") as new (
  bytes: Buffer,
) => {
  readAsText: (path: string) => string;
  getEntries: () => Array<{ entryName: string; getData: () => Buffer }>;
  addFile: (path: string, bytes: Buffer) => void;
  updateFile: (path: string, bytes: Buffer) => void;
  deleteFile: (path: string) => void;
  toBuffer: () => Buffer;
};

function threeChapterPackage(bytes: Buffer) {
  const zip = new Zip(bytes);
  const sourceEntries = zip.getEntries();
  for (const id of ["second", "third"]) {
    for (const entry of sourceEntries) {
      if (!entry.entryName.startsWith("chapters/chapter/")) continue;
      const path = entry.entryName.replace(
        "chapters/chapter/",
        `chapters/${id}/`,
      );
      const data = path.endsWith("chapter.json")
        ? renamedChapter(entry.getData(), id)
        : entry.getData();
      zip.addFile(path, data);
    }
  }
  const manifest = JSON.parse(zip.readAsText("manifest.json"));
  manifest.chapterOrder = ["chapter", "second", "third"];
  zip.updateFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
  return zip;
}
function renamedChapter(bytes: Buffer, id: string) {
  const chapter: LibraryChapter = JSON.parse(bytes.toString());
  chapter.id = id;
  chapter.title = id;
  for (const page of chapter.pages) {
    page.imagePath = page.imagePath.replace(
      "chapters/chapter/",
      `chapters/${id}/`,
    );
    page.inpaintedImagePath = page.inpaintedImagePath?.replace(
      "chapters/chapter/",
      `chapters/${id}/`,
    );
  }
  return Buffer.from(JSON.stringify(chapter));
}

it("imports only selected complete chapters in explicit order and preserves the optional style guide", async () => {
  const f = await workFileFixture();
  try {
    const zip = threeChapterPackage(f.packageBytes);
    const uploaded = await f.upload(zip.toBuffer());
    const review = await f.review(uploaded.uploadId);
    expect(review).toMatchObject({ chapterCount: 3, pageCount: 6 });
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile({
      ...command,
      uploadId: uploaded.uploadId,
      snapshot: review.snapshot,
      chapters: [
        { packageChapterId: "third", title: "First selected" },
        { packageChapterId: "chapter", title: "Second selected" },
      ],
    });
    expect(receipt.packageChapterIds).toEqual(["third", "chapter"]);
    expect(receipt.pageCount).toBe(4);
    const chapters = await Promise.all(
      receipt.chapterIds.map((id) => f.library.openChapter(id)),
    );
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "First selected",
      "Second selected",
    ]);
    const style = JSON.parse(
      await readFile(
        join(f.env.libraryDir, "works", receipt.workId, "style-guide.json"),
        "utf8",
      ),
    );
    const packaged = JSON.parse(zip.readAsText("style-guide.json"));
    expect(style).toEqual({
      ...packaged,
      workId: receipt.workId,
      updatedAt: expect.any(String),
    });
  } finally {
    await f.close();
  }
});

it("supports a work file with no style guide without manufacturing context or chapter memory", async () => {
  const f = await workFileFixture();
  try {
    const zip = new Zip(f.packageBytes);
    zip.deleteFile("style-guide.json");
    const uploaded = await f.upload(zip.toBuffer());
    const review = await f.review(uploaded.uploadId);
    expect(review.hasStyleGuide).toBe(false);
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile({
      ...command,
      uploadId: uploaded.uploadId,
      snapshot: review.snapshot,
    });
    await expect(
      readFile(
        join(f.env.libraryDir, "works", receipt.workId, "style-guide.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(
          f.env.libraryDir,
          "works",
          receipt.workId,
          "chapters",
          receipt.chapterIds[0],
          "memory.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

it("accepts exactly 2,000 archive file entries and rejects the next rather than truncating", async () => {
  const f = await workFileFixture();
  try {
    const zip = new Zip(f.packageBytes);
    const original = zip.getEntries().length;
    for (let i = original; i < 2000; i++)
      zip.addFile(`extra-${i}.txt`, Buffer.from("x"));
    const boundary = await f.upload(zip.toBuffer());
    expect((await f.review(boundary.uploadId)).entryCount).toBe(2000);
    zip.addFile("one-more.txt", Buffer.from("x"));
    const overflow = await f.upload(zip.toBuffer());
    await expect(f.review(overflow.uploadId)).rejects.toThrow();
    expect(f.validateShare).not.toHaveBeenCalled();
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});
