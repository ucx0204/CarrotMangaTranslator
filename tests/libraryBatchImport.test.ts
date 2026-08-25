import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePngImage } from "./helpers/imageFixtures";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
  nativeImage: {
    createFromPath: () => ({
      getSize: () => ({ width: 0, height: 0 }),
    }),
  },
}));

import {
  previewFolder,
  previewImages,
  previewZipFolder,
} from "../src/main/library";

const tempDirs: string[] = [];

describe("image import preview header preflight", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes nested image folders as chapter candidates", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "manga-batch-preview-"));
    tempDirs.push(rootDir);

    const chapterA = join(rootDir, "01 첫화");
    const nestedChapter = join(rootDir, "02 둘째", "scene-a");
    const emptyFolder = join(rootDir, "03 비어있음");
    await mkdir(chapterA, { recursive: true });
    await mkdir(nestedChapter, { recursive: true });
    await mkdir(emptyFolder, { recursive: true });

    await writeFile(join(chapterA, "001.webp"), makePngImage(2, 3));
    await writeFile(join(chapterA, "002.png"), makePngImage(2, 3));
    await writeFile(join(nestedChapter, "001.jpg"), makePngImage(2, 3));
    await writeFile(join(rootDir, "README.txt"), "skip");

    const preview = await previewZipFolder(rootDir);

    expect(preview.mode).toBe("batch");
    expect(preview.suggestedWorkTitle).toBe(rootDir.split(/[/\\]/).pop());
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual([
      "01 첫화",
      "02 둘째/scene-a",
    ]);
    expect(preview.chapters[0]?.pages.map((page) => page.name)).toEqual([
      "001.webp",
      "002.png",
    ]);
    expect(preview.chapters[1]?.pages.map((page) => page.name)).toEqual([
      "001.jpg",
    ]);
  });

  it("excludes an invalid image without rolling back the other batch chapters", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "manga-batch-preview-"));
    tempDirs.push(rootDir);

    const chapterA = join(rootDir, "01 첫화");
    const chapterB = join(rootDir, "02 둘째화");
    const invalidChapter = join(rootDir, "03 손상됨");
    await mkdir(chapterA, { recursive: true });
    await mkdir(chapterB, { recursive: true });
    await mkdir(invalidChapter, { recursive: true });
    await writeFile(join(chapterA, "001.png"), makePngImage(2, 3));
    await writeFile(join(chapterA, "002.png"), "not an image");
    await writeFile(join(chapterB, "001.png"), makePngImage(2, 3));
    await writeFile(join(invalidChapter, "001.png"), "not an image");

    const preview = await previewZipFolder(rootDir);

    expect(preview.chapters.map((chapter) => chapter.title)).toEqual([
      "01 첫화",
      "02 둘째화",
    ]);
    expect(preview.chapters[0]?.pages.map((page) => page.name)).toEqual([
      "001.png",
    ]);
    expect(preview.excludedPages).toEqual([
      {
        chapterTitle: "01 첫화",
        pageName: "002.png",
        reason: "invalid-image-header",
      },
      {
        chapterTitle: "03 손상됨",
        pageName: "001.png",
        reason: "invalid-image-header",
      },
    ]);
  });

  it("reports an invalid image while keeping valid files selected directly", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "manga-images-preview-"));
    tempDirs.push(rootDir);
    const validPath = join(rootDir, "001.png");
    const invalidPath = join(rootDir, "002.png");
    await writeFile(validPath, makePngImage(2, 3));
    await writeFile(invalidPath, "not an image");

    const preview = await previewImages([invalidPath, validPath]);

    expect(preview.chapters[0]?.pages.map((page) => page.name)).toEqual([
      "001.png",
    ]);
    expect(preview.excludedPages).toEqual([
      {
        chapterTitle: preview.chapters[0]?.title,
        pageName: "002.png",
        reason: "invalid-image-header",
      },
    ]);
    await expect(previewImages([invalidPath])).rejects.toThrow(/002\.png/u);
  });

  it("reports an invalid image while keeping valid files in a folder", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "manga-folder-preview-"));
    tempDirs.push(rootDir);
    const mixedFolder = join(rootDir, "mixed");
    const invalidFolder = join(rootDir, "invalid-only");
    await mkdir(mixedFolder, { recursive: true });
    await mkdir(invalidFolder, { recursive: true });
    await writeFile(join(mixedFolder, "001.png"), makePngImage(2, 3));
    await writeFile(join(mixedFolder, "002.png"), "not an image");
    await writeFile(join(invalidFolder, "003.png"), "not an image");

    const preview = await previewFolder(mixedFolder);

    expect(preview.chapters[0]?.pages.map((page) => page.name)).toEqual([
      "001.png",
    ]);
    expect(preview.excludedPages).toEqual([
      {
        chapterTitle: "mixed",
        pageName: "002.png",
        reason: "invalid-image-header",
      },
    ]);
    await expect(previewFolder(invalidFolder)).rejects.toThrow(/003\.png/u);
  });

  it("rejects a batch when every candidate image has an invalid header", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "manga-batch-preview-"));
    tempDirs.push(rootDir);
    const invalidChapter = join(rootDir, "01 손상됨");
    await mkdir(invalidChapter, { recursive: true });
    await writeFile(join(invalidChapter, "002.png"), "not an image");

    await expect(previewZipFolder(rootDir)).rejects.toThrow(
      /01 손상됨 \/ 002\.png/u,
    );
  });
});
