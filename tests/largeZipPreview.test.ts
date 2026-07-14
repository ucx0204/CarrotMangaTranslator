import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
  nativeImage: {
    createFromPath: () => {
      throw new Error("ZIP preview must not decode image entries");
    },
  },
}));

import { previewZip } from "../src/main/library";

const AdmZip = require("adm-zip") as {
  new (): {
    addFile: (entryName: string, content: Buffer) => void;
    writeZip: (targetPath: string) => void;
  };
};

const tempDirs: string[] = [];

describe("large ZIP preview", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("previews 600 image entries in natural order without decoding them", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "manga-large-zip-preview-"));
    tempDirs.push(rootDir);
    const archivePath = join(rootDir, "600-pages.zip");
    const zip = new AdmZip();

    for (let pageNumber = 600; pageNumber >= 1; pageNumber -= 1) {
      zip.addFile(
        `pages/page-${pageNumber}.png`,
        Buffer.from(`not-decoded-${pageNumber}`),
      );
    }
    zip.addFile("pages/notes.txt", Buffer.from("ignored"));
    zip.writeZip(archivePath);

    const preview = await previewZip(archivePath);
    const pages = preview.chapters[0]?.pages;
    const expectedNames = Array.from(
      { length: 600 },
      (_, index) => `pages/page-${index + 1}.png`,
    );

    expect(preview.mode).toBe("single");
    expect(preview.sourceKind).toBe("zip");
    expect(pages).toHaveLength(600);
    expect(pages?.map((page) => page.name)).toEqual(expectedNames);
    expect(pages?.map((page) => page.zipEntryName)).toEqual(expectedNames);
    expect(pages?.every((page) => page.sourceKind === "zip-entry")).toBe(true);
    expect(pages?.every((page) => page.sourcePath === archivePath)).toBe(true);
  });
});
