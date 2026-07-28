import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  appendBubbleLayoutPolygonPoint,
  createBubbleLayoutDraft,
  undoBubbleLayoutDraft,
} from "../src/renderer/src/lib/bubbleLayoutDraft";

describe("bubble layout editor draft", () => {
  it("caps geometry history and keeps the selected text direction", () => {
    const block = makeBlock();
    let draft = createBubbleLayoutDraft(block, makePage(block));
    for (let index = 0; index < 100; index += 1) {
      const angle = (index / 100) * Math.PI * 2;
      draft = appendBubbleLayoutPolygonPoint(draft, {
        x: 500 + Math.cos(angle) * 180,
        y: 500 + Math.sin(angle) * 120,
      });
    }

    expect(draft.history).toHaveLength(80);
    expect(draft.shape?.bubbleLayout).toMatchObject({
      direction: "vertical",
      origin: "manual",
    });
    for (let index = 0; index < 80; index += 1) {
      draft = undoBubbleLayoutDraft(draft);
    }
    expect(draft.points).toHaveLength(20);
    expect(draft.history).toHaveLength(0);
  });

  it("starts generated shape editing from the same disjoint geometry as rendering", () => {
    const block = makeBlock();
    block.renderDirection = "horizontal";
    block.bubbleLayout = {
      version: 1,
      direction: "horizontal",
      confidence: 0.95,
      origin: "detected",
      modelId: "comic-rtdetr-bubble-v1",
      sourceImageRevision: "revision-1",
      insetRatio: 0.04,
      regions: [
        {
          spans: [
            {
              blockStart: 0,
              blockEnd: 1,
              inlineStart: 0.05,
              inlineEnd: 0.6,
            },
          ],
        },
        {
          spans: [
            {
              blockStart: 0,
              blockEnd: 1,
              inlineStart: 0.4,
              inlineEnd: 0.95,
            },
          ],
        },
      ],
    };
    const draft = createBubbleLayoutDraft(block, makePage(block));
    const leftEnd =
      draft.shape?.bubbleLayout.regions[0]?.spans[0]?.inlineEnd ?? 0;
    const rightStart =
      draft.shape?.bubbleLayout.regions[1]?.spans[0]?.inlineStart ?? 1;

    expect(rightStart - leftEnd).toBeCloseTo(4 / 400);
  });

  it("does not sanitize explicitly manual draft geometry", () => {
    const block = makeBlock();
    block.renderDirection = "horizontal";
    block.bubbleLayout = {
      version: 1,
      direction: "horizontal",
      confidence: 1,
      origin: "manual",
      modelId: "manual-shape-v1",
      insetRatio: 0,
      regions: [
        {
          spans: [
            {
              blockStart: 0,
              blockEnd: 1,
              inlineStart: 0.05,
              inlineEnd: 0.6,
            },
          ],
        },
        {
          spans: [
            {
              blockStart: 0,
              blockEnd: 1,
              inlineStart: 0.4,
              inlineEnd: 0.95,
            },
          ],
        },
      ],
    };
    const draft = createBubbleLayoutDraft(block, makePage(block));

    expect(draft.shape?.bubbleLayout.regions).toEqual(
      block.bubbleLayout.regions,
    );
  });
});

function makePage(block: TranslationBlock): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [block],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 300, y: 350, w: 400, h: 300 },
    sourceText: "",
    translatedText: "",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "vertical",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
