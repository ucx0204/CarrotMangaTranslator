import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlockLibraryStore } from "../src/main/blockLibraryStore";
import {
  BlockLibrarySnapshotV1Schema,
  createBlockLibrarySaveInput,
  instantiateBlockLibraryEntry,
  resolveBlockLibraryDefaultName,
  type BlockLibraryEntryV1,
} from "../src/shared/blockLibrary";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  filterAndSortBlockLibraryEntries,
  resolveBlockLibraryThumbnailModel,
} from "../src/renderer/src/components/blockLibraryModel";
import { resolveTransformedBlockBounds } from "../src/shared/editableRenderGeometry";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("block library template contract", () => {
  it("keeps reusable appearance while structurally dropping page-only data", () => {
    const input = createBlockLibrarySaveInput(makePageBlock(), {
      width: 1200,
      height: 1800,
    });

    expect(input.name).toBe("あ あ");
    expect(input.block.size).toEqual({ w: 420, h: 330 });
    expect(input.block).toMatchObject({
      translatedText: "아아",
      fontFamily: "custom-sfx",
      fontSizePx: 72,
      rotationDeg: 15,
      outlineWidthPx: 4,
    });
    expect(input.block).not.toHaveProperty("id");
    expect(input.block).not.toHaveProperty("bbox");
    expect(input.block).not.toHaveProperty("confidence");
    expect(input.block).not.toHaveProperty("reviewStatus");
    expect(input.block).not.toHaveProperty("speakerId");
    expect(input.block).not.toHaveProperty("inpaintExcluded");
    expect(input.block).not.toHaveProperty("fontRole");
    expect(input.block).not.toHaveProperty("visualClusterId");
    expect(input.block).not.toHaveProperty("bubbleLayout");
  });

  it("creates a new centered block that remains recoverably visible", () => {
    const entry = makeEntry({ size: { w: 1800, h: 1600 } });
    const block = instantiateBlockLibraryEntry(entry, "new-block");

    expect(block.id).toBe("new-block");
    expect(block.bbox).toEqual({ x: 0, y: 0, w: 1000, h: 1000 });
    expect(block.renderBbox).toEqual({ x: -400, y: -300, w: 1800, h: 1600 });
    expect(block.renderBboxSpace).toBe("normalized_1000");
    expect(block).not.toHaveProperty("reviewStatus");
    expect(block).not.toHaveProperty("inpaintExcluded");
  });

  it("uses source, then translation, then a stable fallback name", () => {
    expect(
      resolveBlockLibraryDefaultName({
        sourceText: " 원\n문 ",
        translatedText: "번역",
      }),
    ).toBe("원 문");
    expect(
      resolveBlockLibraryDefaultName({
        sourceText: "",
        translatedText: " 번역 ",
      }),
    ).toBe("번역");
    expect(
      resolveBlockLibraryDefaultName({ sourceText: "", translatedText: "" }),
    ).toBe("새 블록");
  });

  it("rejects unknown fields in persisted templates", () => {
    const snapshot = {
      schemaVersion: 1,
      entries: [
        {
          ...makeEntry(),
          block: { ...makeEntry().block, bbox: { x: 0, y: 0, w: 10, h: 10 } },
        },
      ],
    };
    expect(() => BlockLibrarySnapshotV1Schema.parse(snapshot)).toThrow();
  });
});

describe("BlockLibraryStore", () => {
  it("atomically saves, reloads, renames, uses, and deletes entries", async () => {
    const root = await makeTemporaryRoot();
    const store = new BlockLibraryStore(root);
    const first = await store.save(makeSaveInput("첫 블록"));
    const firstEntry = first.entries[0];
    if (!firstEntry) throw new Error("saved entry is missing");
    const firstId = firstEntry.id;

    const reopened = new BlockLibraryStore(root);
    expect((await reopened.list()).entries[0]?.name).toBe("첫 블록");
    const renamed = await reopened.rename({ id: firstId, name: "새 이름" });
    expect(renamed.entries[0]?.name).toBe("새 이름");
    const updated = await reopened.update({
      id: firstId,
      name: "전체 수정",
      block: {
        ...makeSaveInput("무시").block,
        translatedText: "수정된 번역",
        fontSizePx: 111,
      },
    });
    expect(updated.entries[0]).toMatchObject({
      id: firstId,
      name: "전체 수정",
      block: { translatedText: "수정된 번역", fontSizePx: 111 },
    });
    expect(updated.entries[0]?.createdAt).toBe(firstEntry.createdAt);
    const beforeUse = updated.entries[0]?.lastUsedAt;
    if (!beforeUse) throw new Error("renamed entry is missing");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const used = await reopened.use(firstId);
    expect(used.lastUsedAt >= beforeUse).toBe(true);
    expect((await reopened.delete(firstId)).entries).toEqual([]);

    const files = await readdir(root);
    expect(files).toEqual(["block-library.json"]);
    expect(
      BlockLibrarySnapshotV1Schema.parse(
        JSON.parse(await readFile(join(root, "block-library.json"), "utf8")),
      ).entries,
    ).toEqual([]);
  });

  it("serializes concurrent mutations without losing entries", async () => {
    const root = await makeTemporaryRoot();
    const store = new BlockLibraryStore(root);
    await Promise.all([
      store.save(makeSaveInput("하나")),
      store.save(makeSaveInput("둘")),
      store.save(makeSaveInput("셋")),
    ]);
    expect(
      (await store.list()).entries.map((entry) => entry.name).sort(),
    ).toEqual(["둘", "셋", "하나"]);
  });

  it("rejects a corrupt file without replacing it", async () => {
    const root = await makeTemporaryRoot();
    const path = join(root, "block-library.json");
    await writeFile(path, "{ broken", "utf8");
    const store = new BlockLibraryStore(root);
    await expect(store.save(makeSaveInput("보존"))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });
});

describe("block library filtering", () => {
  it("searches every visible text field and supports both sort orders", () => {
    const older = makeEntry({
      id: "older",
      name: "가나다",
      translatedText: "별빛",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = makeEntry({
      id: "newer",
      name: "라마",
      sourceText: "星",
      lastUsedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(
      filterAndSortBlockLibraryEntries([older, newer], "별빛", "recent"),
    ).toEqual([older]);
    expect(
      filterAndSortBlockLibraryEntries([older, newer], "星", "recent"),
    ).toEqual([newer]);
    expect(
      filterAndSortBlockLibraryEntries([newer, older], "", "name", "ko"),
    ).toEqual([older, newer]);
  });
});

describe("block library thumbnail camera", () => {
  it("fills the preview with the transformed block instead of the whole page", () => {
    const block = instantiateBlockLibraryEntry(
      makeEntry({ size: { w: 300, h: 200 } }),
      "preview",
    );
    const model = resolveBlockLibraryThumbnailModel(block);
    const bounds = resolveTransformedBlockBounds(
      model.block,
      model.block.renderBbox ?? model.block.bbox,
    );

    expect(model.zoom).toBeCloseTo(860 / 300);
    expect(bounds.x + bounds.w / 2).toBeCloseTo(500);
    expect(bounds.y + bounds.h / 2).toBeCloseTo(500);
    expect(Math.max(bounds.w, bounds.h) * model.zoom).toBeCloseTo(860);
    expect(block.renderBbox).toEqual({ x: 350, y: 400, w: 300, h: 200 });
  });

  it("centers and contains rotated blocks while bounding extreme zoom", () => {
    const block = {
      ...instantiateBlockLibraryEntry(
        makeEntry({ size: { w: 100, h: 300 } }),
        "rotated-preview",
      ),
      rotationDeg: 90,
    };
    const model = resolveBlockLibraryThumbnailModel(block);
    const bounds = resolveTransformedBlockBounds(
      model.block,
      model.block.renderBbox ?? model.block.bbox,
    );

    expect(model.zoom).toBeCloseTo(860 / 300);
    expect(bounds.x + bounds.w / 2).toBeCloseTo(500);
    expect(bounds.y + bounds.h / 2).toBeCloseTo(500);
    expect(
      resolveBlockLibraryThumbnailModel({
        ...block,
        renderBbox: { x: 499.5, y: 499.5, w: 1, h: 1 },
      }).zoom,
    ).toBe(48);
  });
});

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mgt-block-library-"));
  temporaryRoots.push(root);
  return root;
}

function makeSaveInput(name: string) {
  return createBlockLibrarySaveInput(
    makePageBlock(),
    { width: 1200, height: 1800 },
    name,
  );
}

function makePageBlock(): TranslationBlock {
  return {
    id: "source-block",
    type: "nonsolid",
    bbox: { x: 100, y: 120, w: 200, h: 220 },
    renderBbox: { x: -20, y: 250, w: 420, h: 330 },
    renderBboxSpace: "normalized_1000",
    bubbleLayout: {
      version: 1,
      direction: "horizontal",
      confidence: 1,
      origin: "manual",
      insetRatio: 0.1,
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
    },
    sourceText: " あ\nあ ",
    translatedText: "아아",
    textRole: "sound",
    fontRole: "sfx_impact",
    fontRoleConfidence: 0.95,
    visualClusterId: "cluster-page-only",
    confidence: 0.72,
    sourceDirection: "vertical",
    renderDirection: "vertical",
    rotationDeg: 15,
    fontFamily: "custom-sfx",
    fontSizePx: 72,
    lineHeight: 1.1,
    letterSpacing: -0.1,
    fontWidthScale: 1.4,
    wordBreak: "keep-all-overflow",
    textAlign: "center",
    textColor: "#111111",
    textOpacity: 0.8,
    outlineColor: "#ffffff",
    outlineWidthPx: 4,
    bold: true,
    backgroundColor: "#ffeeaa",
    opacity: 0.7,
    autoFitText: false,
    inpaintExcluded: true,
    reviewStatus: "reviewed",
    reviewNote: "page only",
    speakerId: "speaker-a",
    glossaryEntryIds: ["term-a"],
  };
}

function makeEntry(
  overrides: Partial<{
    id: string;
    name: string;
    sourceText: string;
    translatedText: string;
    lastUsedAt: string;
    size: { w: number; h: number };
  }> = {},
): BlockLibraryEntryV1 {
  const timestamp = overrides.lastUsedAt ?? "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: overrides.id ?? "library-entry",
    name: overrides.name ?? "저장 블록",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: timestamp,
    block: {
      sourceText: overrides.sourceText ?? "原文",
      translatedText: overrides.translatedText ?? "번역",
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 48,
      lineHeight: 1.2,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#ffffff",
      opacity: 0.7,
      size: overrides.size ?? { w: 300, h: 200 },
    },
  };
}
