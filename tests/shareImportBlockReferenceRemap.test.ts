import { describe, expect, it } from "vitest";
import {
  buildMaterializedSharedPage,
  remapSharedPageBlocks,
} from "../src/main/libraryStore/shareImportPageRecord";
import type { LibraryPageRecord } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("shared page block reference remap", () => {
  it("remaps blocks and completion references to the destination page ids", () => {
    const packagePage = makePage([
      makeBlock("source-a"),
      makeBlock("source-b"),
      makeBlock("source-c"),
    ]);
    packagePage.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: ["source-b", "source-c"],
    };
    const before = structuredClone(packagePage);

    const result = buildMaterializedSharedPage({
      packagePage,
      pageId: "new-page-id",
      imagePath: "destination.png",
      inpaintedImagePath: "destination-inpainted.png",
      width: 640,
      height: 960,
      now: "2026-08-07T00:00:00.000Z",
    });

    expect(result.blocks.map((block) => block.id)).toEqual([
      "new-page-id-block-1",
      "new-page-id-block-2",
      "new-page-id-block-3",
    ]);
    expect(result.translationCompletion).toEqual({
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: ["new-page-id-block-2", "new-page-id-block-3"],
    });
    const destinationIds = new Set(result.blocks.map((block) => block.id));
    expect(
      result.translationCompletion?.erasedBlockIds?.every((id) =>
        destinationIds.has(id),
      ),
    ).toBe(true);
    expect(result.translationCompletion?.erasedBlockIds).not.toContain(
      "source-b",
    );
    expect(packagePage).toEqual(before);
  });

  it("preserves block fields other than id", () => {
    const source = makeBlock("source-a");
    source.translatedText = "manual translation";
    source.visualClusterId = "cluster-a";
    source.speakerId = "speaker-a";
    source.glossaryEntryIds = ["glossary-a"];
    source.reviewStatus = "reviewed";
    source.bubbleLayout = {
      version: 1,
      direction: "horizontal",
      confidence: 0.9,
      insetRatio: 0.05,
      regions: [
        {
          spans: [
            {
              blockStart: 0,
              blockEnd: 1,
              inlineStart: 0,
              inlineEnd: 1,
            },
          ],
        },
      ],
    };

    const result = buildMaterializedSharedPage({
      packagePage: makePage([source]),
      pageId: "new-page-id",
      imagePath: "destination.png",
      width: 100,
      height: 200,
      now: "2026-08-07T00:00:00.000Z",
    });

    expect(result.blocks[0]).toEqual({
      ...source,
      id: "new-page-id-block-1",
    });
  });

  it("uses a Map and safely handles prototype-looking source ids", () => {
    const { blocks, blockIdMap } = remapSharedPageBlocks("page", [
      makeBlock("__proto__"),
      makeBlock("constructor"),
    ]);

    expect(blockIdMap).toBeInstanceOf(Map);
    expect(blockIdMap.get("__proto__")).toBe("page-block-1");
    expect(blockIdMap.get("constructor")).toBe("page-block-2");
    expect(blocks.map((block) => block.id)).toEqual([
      "page-block-1",
      "page-block-2",
    ]);
  });

  it("rejects duplicate source block ids", () => {
    expect(() =>
      remapSharedPageBlocks("page", [makeBlock("same"), makeBlock("same")]),
    ).toThrow();
  });

  it("invalidates an unknown source receipt all-or-nothing", () => {
    const packagePage = makePage([
      makeBlock("source-a"),
      makeBlock("source-b"),
    ]);
    packagePage.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
      erasedBlockIds: ["source-a", "legacy-missing"],
    };

    const result = buildMaterializedSharedPage({
      packagePage,
      pageId: "new-page-id",
      imagePath: "destination.png",
      width: 100,
      height: 200,
      now: "2026-08-07T00:00:00.000Z",
    });

    expect(result.translationCompletion).toEqual({
      workflow: "erase-original",
      status: "pending",
    });
  });

  it("explicitly overwrites an absent source completion", () => {
    const packagePage = makePage([makeBlock("source-a")]);

    const result = buildMaterializedSharedPage({
      packagePage,
      pageId: "new-page-id",
      imagePath: "destination.png",
      width: 100,
      height: 200,
      now: "2026-08-07T00:00:00.000Z",
    });

    expect(result).toHaveProperty("translationCompletion", undefined);
  });
});

function makePage(blocks: TranslationBlock[]): LibraryPageRecord {
  return {
    id: "source-page",
    name: "page.png",
    imagePath: "source.png",
    inpaintedImagePath: "source-inpainted.png",
    width: 10,
    height: 20,
    blocks,
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(id: string): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 32,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#ffffff",
    backgroundColor: "transparent",
    opacity: 1,
  };
}
