import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  MAX_SHARE_CHAPTERS,
  SHARE_FORMAT,
  SHARE_VERSION,
} from "../src/main/libraryStore/sharePackage";
import { previewWorkShareImport } from "../src/main/libraryStore/shareWorkflow";
import { AdmZip } from "../src/main/libraryStore/zipSafety";

it("loads all 2000 chapters from one share package in manifest order", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-share-scale-"));
  try {
    const packagePath = join(rootDir, "scale-2000.mgtshare");
    const chapterIds = Array.from(
      { length: MAX_SHARE_CHAPTERS },
      (_, index) => `chapter-${String(index + 1).padStart(4, "0")}`,
    );
    const zip = new AdmZip();
    zip.addFile(
      "manifest.json",
      JSON.stringify({
        format: SHARE_FORMAT,
        version: SHARE_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        work: {
          id: "scale-work",
          title: "2000 Chapter Work",
        },
        chapterOrder: chapterIds,
      }),
    );
    chapterIds.forEach((chapterId, index) => {
      zip.addFile(
        `chapters/${chapterId}/chapter.json`,
        JSON.stringify({
          id: chapterId,
          workId: "scale-work",
          title: `Chapter ${index + 1}`,
          sourceKind: "folder",
          status: "idle",
          pageOrder: [],
          pages: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    });
    zip.writeZip(packagePath);

    const preview = await previewWorkShareImport(packagePath);

    expect(preview.chapters).toHaveLength(MAX_SHARE_CHAPTERS);
    expect(preview.chapters[0]?.packageChapterId).toBe("chapter-0001");
    expect(preview.chapters.at(-1)?.packageChapterId).toBe("chapter-2000");
    expect(preview.chapters.map((chapter) => chapter.packageChapterId)).toEqual(
      chapterIds,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}, 60_000);
