import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  createPageRevision,
  createPageVisualRevision,
  matchesRegionPageRevision,
} from "../src/shared/pageRevision";

describe("page job revisions", () => {
  it("allows only newly materialized derived masks for region jobs", () => {
    const page = { ...makePage(), inpaintedImagePath: "background.png" };
    const revision = createPageRevision(page);
    const derived: MangaPage = {
      ...page,
      inpaintMaskPath: "derived.png",
      maskProvenance: "derived-diff",
    };
    expect(matchesRegionPageRevision(derived, revision)).toBe(true);
    // Other jobs and persisted checkpoints retain their exact revision contract.
    expect(createPageRevision(derived)).not.toBe(revision);
    const variants: MangaPage[] = [
      { ...derived, imagePath: "changed-original.png" },
      { ...derived, inpaintedImagePath: "changed-background.png" },
      { ...derived, inpaintedImagePath: undefined },
      { ...derived, width: page.width + 1 },
      { ...derived, blocks: [] },
      { ...derived, maskProvenance: "actual-mask" },
      { ...derived, maskProvenance: "retouch-updated" },
      { ...derived, maskProvenance: undefined },
      {
        ...derived,
        translationCompletion: {
          workflow: "erase-original",
          status: "pending",
        },
      },
    ];
    for (const edited of variants)
      expect(matchesRegionPageRevision(edited, revision)).toBe(false);
    expect(
      matchesRegionPageRevision(
        { ...derived, inpaintMaskPath: "replaced.png" },
        createPageRevision(derived),
      ),
    ).toBe(false);
    expect(matchesRegionPageRevision(page, createPageRevision(derived))).toBe(
      false,
    );
  });
  it("invalidates rendered-image caches when source editing switches generated lettering to text", () => {
    const page = makePage();
    const original = page.blocks[0];
    if (!original) throw new Error("Missing fixture block");
    const block = {
      ...original,
      generatedLettering: {
        version: 1 as const,
        sourceText: original.sourceText,
        translatedText: original.translatedText,
        dataUrl: "data:image/png;base64,aA==",
      },
    };
    const active = { ...page, blocks: [block] };
    const edited = {
      ...page,
      blocks: [{ ...block, sourceText: "edited source" }],
    };
    expect(createPageVisualRevision(edited)).not.toBe(
      createPageVisualRevision(active),
    );
    expect(
      createPageVisualRevision({
        ...page,
        blocks: [{ ...original, sourceText: "metadata edit" }],
      }),
    ).toBe(createPageVisualRevision(page));
  });

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
