import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import { createPageRevision } from "../src/shared/pageRevision";

describe("page job revisions", () => {
  it("ignores runtime status and timestamp changes", () => {
    const page = makePage();
    const revision = createPageRevision(page);

    const runtimeOnlyChange: MangaPage = {
      ...page,
      analysisStatus: "running",
      lastError: "temporary",
      updatedAt: "2030-02-03T04:05:06.000Z",
    };
    expect(createPageRevision(runtimeOnlyChange)).toBe(revision);
  });

  it("changes when any job-relevant page content changes", () => {
    const page = makePage();
    const revision = createPageRevision(page);
    const block = page.blocks[0];
    if (!block) throw new Error("test block is missing");
    const variants: MangaPage[] = [
      { ...page, imagePath: "changed.png" },
      { ...page, inpaintedImagePath: "inpainted.png" },
      { ...page, width: page.width + 1 },
      {
        ...page,
        blocks: [{ ...block, translatedText: "manual edit" }],
      },
      {
        ...page,
        translationCompletion: {
          workflow: "erase-original",
          status: "pending",
        },
      },
    ];

    expect(variants.map(createPageRevision)).not.toContain(revision);
    expect(new Set(variants.map(createPageRevision)).size).toBe(
      variants.length,
    );
  });
});

function makePage(): MangaPage {
  return {
    id: "page-a",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [
      {
        id: "block-a",
        type: "nonsolid",
        bbox: { x: 100, y: 100, w: 300, h: 200 },
        sourceText: "原文",
        translatedText: "번역",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 32,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "transparent",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
