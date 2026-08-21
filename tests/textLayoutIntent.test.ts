import { describe, expect, it } from "vitest";
import { runBubbleLayoutPostprocess } from "../src/main/inpainting/bubbleLayoutRunner";
import { applyBubbleNaturalTextLayout } from "../src/main/inpainting/bubbleLayoutNaturalText";
import type { BubbleLayout } from "../src/shared/bubbleLayout";
import { TranslationBlockSchema } from "../src/shared/ipcSchemas";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("Gemma text layout intent", () => {
  it("applies a long outer-edge vertical advisory only after a no-bubble result", async () => {
    const page = makePage();
    const original = structuredClone(page.blocks[0]);
    let runnerDirection: TranslationBlock["renderDirection"] | undefined;
    const processed = await runBubbleLayoutPostprocess({
      page,
      config: {
        policy: "safe",
        overwriteManual: false,
        naturalTextLayout: { locale: "ko" },
      },
      runner: {
        runPage: async ({ page: runnerPage }) => {
          runnerDirection = runnerPage.blocks[0]?.renderDirection;
          return { patches: [] };
        },
      },
      signal: new AbortController().signal,
    });

    const block = processed.page.blocks[0];
    expect(runnerDirection).toBe("horizontal");
    expect(block?.renderDirection).toBe("vertical");
    expect(block?.sourceDirection).toBe(original?.sourceDirection);
    expect(block?.bbox).toEqual(original?.bbox);
    expect(block?.renderBbox).toBeUndefined();
    expect(block?.bubbleLayout).toBeUndefined();
    expect(block?.translatedText).not.toContain("\n");
    expect(processed.beforeLayout?.[0]).toMatchObject({
      renderDirection: "horizontal",
    });
    expect(processed.afterLayout?.[0]).toMatchObject({
      renderDirection: "vertical",
    });
  });

  it.each([
    ["centered", { x: 450, y: 100, w: 70, h: 600 }, "ordinary"],
    ["not tall", { x: 20, y: 100, w: 300, h: 180 }, "ordinary"],
    ["sound", { x: 20, y: 100, w: 70, h: 600 }, "sound"],
  ] as const)(
    "rejects a vertical advisory for a %s block",
    (_label, bbox, textRole) => {
      const page = makePage({ bbox, textRole });
      const processed = applyBubbleNaturalTextLayout(page, { locale: "ko" });

      expect(processed.blocks[0]?.renderDirection).toBe("horizontal");
      expect(processed.blocks[0]?.bbox).toEqual(bbox);
    },
  );

  it.each(["dialogue", "shout"] as const)(
    "keeps but rejects a tall outer-edge %s vertical advisory",
    (fontRole) => {
      const page = makePage({ fontRole, fontRoleConfidence: 0.99 });
      const processed = applyBubbleNaturalTextLayout(page, { locale: "ko" });

      expect(processed.blocks[0]?.layoutIntent).toBe("vertical");
      expect(processed.blocks[0]?.renderDirection).toBe("horizontal");
      expect(processed.blocks[0]?.bbox).toEqual(page.blocks[0]?.bbox);
    },
  );

  it("rejects an uncertain narration role while preserving the raw advisory", () => {
    const page = makePage({
      fontRole: "narration",
      fontRoleConfidence: 0.81,
    });
    const processed = applyBubbleNaturalTextLayout(page, { locale: "ko" });

    expect(processed.blocks[0]?.layoutIntent).toBe("vertical");
    expect(processed.blocks[0]?.renderDirection).toBe("horizontal");
  });

  it("never applies the advisory to a usable bubble profile", () => {
    const bubbleLayout = makeBubbleLayout();
    const page = makePage({ bubbleLayout });
    const processed = applyBubbleNaturalTextLayout(page, { locale: "ko" });

    expect(processed.blocks[0]?.renderDirection).toBe("horizontal");
    expect(processed.blocks[0]?.bubbleLayout).toEqual(bubbleLayout);
    expect(processed.blocks[0]?.bbox).toEqual(page.blocks[0]?.bbox);
  });

  it("does not normalize an existing bubble direction without an advisory", () => {
    const bubbleLayout = makeBubbleLayout();
    const page = makePage({
      bubbleLayout,
      layoutIntent: undefined,
      renderDirection: "vertical",
    });
    const processed = applyBubbleNaturalTextLayout(page, { locale: "ko" });

    expect(processed.blocks[0]?.renderDirection).toBe("vertical");
    expect(processed.blocks[0]?.bubbleLayout).toEqual(bubbleLayout);
  });

  it("round-trips supported intents through the persisted block schema", () => {
    const block = {
      ...makePage().blocks[0],
      backgroundColor: "#ffffff",
    };
    expect(TranslationBlockSchema.parse(block).layoutIntent).toBe("vertical");
    expect(
      TranslationBlockSchema.parse({
        ...block,
        layoutIntent: undefined,
        layoutIntentSuppressed: true,
      }).layoutIntentSuppressed,
    ).toBe(true);
    expect(
      TranslationBlockSchema.safeParse({
        ...block,
        layoutIntent: "diagonal",
      }).success,
    ).toBe(false);
    expect(
      TranslationBlockSchema.safeParse({
        ...block,
        layoutIntent: undefined,
      }).success,
    ).toBe(true);
    expect(
      TranslationBlockSchema.safeParse({
        ...block,
        layoutIntentSuppressed: false,
      }).success,
    ).toBe(false);
  });
});

function makePage(blockPatch: Partial<TranslationBlock> = {}): MangaPage {
  return {
    id: "page-layout-intent",
    name: "001.png",
    imagePath: "C:/manga/001.png",
    dataUrl: "",
    width: 1000,
    height: 1500,
    blocks: [
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 20, y: 100, w: 70, h: 600 },
        bboxSpace: "normalized_1000",
        sourceText: "ページ外側の長い説明文です",
        translatedText:
          "페이지 바깥쪽에 놓인 아주 길고 세로로 이어지는 설명문입니다",
        textRole: "ordinary",
        fontRole: "narration",
        fontRoleConfidence: 0.95,
        confidence: 1,
        sourceDirection: "vertical",
        layoutIntent: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 20,
        lineHeight: 1.18,
        textAlign: "center",
        textColor: "#111111",
        outlineColor: "#ffffff",
        backgroundColor: "transparent",
        opacity: 1,
        autoFitText: true,
        ...blockPatch,
      },
    ],
    analysisStatus: "completed",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function makeBubbleLayout(): BubbleLayout {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.9,
    origin: "manual",
    insetRatio: 0.08,
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
}
