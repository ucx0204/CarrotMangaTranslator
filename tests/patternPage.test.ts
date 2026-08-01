import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import type { MangaPage } from "../src/shared/libraryTypes";

const nativeImageMocks = vi.hoisted(() => ({
  createFromBitmap: vi.fn(),
  createFromBuffer: vi.fn(),
  createFromPath: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeImage: nativeImageMocks,
}));

const previousLogPath = process.env.MANGA_TRANSLATOR_LOG_PATH;
const testLogDirectory = mkdtempSync(join(tmpdir(), "pattern-page-test-"));

beforeAll(() => {
  process.env.MANGA_TRANSLATOR_LOG_PATH = join(testLogDirectory, "app.log");
});

afterAll(() => {
  if (previousLogPath === undefined) {
    delete process.env.MANGA_TRANSLATOR_LOG_PATH;
  } else {
    process.env.MANGA_TRANSLATOR_LOG_PATH = previousLogPath;
  }
  rmSync(testLogDirectory, { force: true, recursive: true });
});

describe("pattern page inpainting result validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const bitmap = Buffer.alloc(32 * 32 * 4, 255);
    nativeImageMocks.createFromPath.mockReturnValue({
      getSize: () => ({ width: 32, height: 32 }),
      isEmpty: () => false,
      toBitmap: () => Buffer.from(bitmap),
    });
    nativeImageMocks.createFromBitmap.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => Buffer.from("png"),
    });
  });

  it("returns no result when the engine changes no masked pixels", async () => {
    const inpaint = vi.fn<InpaintingEngine["inpaint"]>(async () => undefined);
    const engine: InpaintingEngine = {
      model: "lama-manga",
      runtimePath: "C:\\runtime\\inpaint.exe",
      backend: "cpu",
      runRootDir: "C:\\runtime\\runs",
      inpaint,
      dispose: vi.fn(async () => undefined),
    };
    const page = makePage();
    const { inpaintPatternPage } =
      await import("../src/main/inpainting/patternPage");

    const result = await inpaintPatternPage(page, {
      inpaintingEngine: engine,
    });

    expect(inpaint).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      page,
      blocksErased: 0,
      blocksIncomplete: 1,
      erasedBlockIds: [],
      incompleteBlockIds: ["block-1"],
    });
    expect(nativeImageMocks.createFromBitmap).not.toHaveBeenCalled();
  });

  it("starts a freshly translated pending workflow from the original image", async () => {
    const engine: InpaintingEngine = {
      model: "lama-manga",
      runtimePath: "C:\\runtime\\inpaint.exe",
      backend: "cpu",
      runRootDir: "C:\\runtime\\runs",
      inpaint: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const page = makePage();
    page.inpaintedImagePath = join(testLogDirectory, "old-clean.png");
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    const { inpaintPatternPage } =
      await import("../src/main/inpainting/patternPage");

    await inpaintPatternPage(page, { inpaintingEngine: engine });

    expect(nativeImageMocks.createFromPath).toHaveBeenCalledWith(
      page.imagePath,
    );
  });

  it("writes changed targets when another target mask stays unchanged", async () => {
    const inpaint = vi.fn<InpaintingEngine["inpaint"]>(async (bitmap) => {
      const offset = (16 * 32 + 16) * 4;
      bitmap[offset] = 0;
      bitmap[offset + 1] = 0;
      bitmap[offset + 2] = 0;
    });
    const engine: InpaintingEngine = {
      model: "lama-manga",
      runtimePath: "C:\\runtime\\inpaint.exe",
      backend: "cpu",
      runRootDir: "C:\\runtime\\runs",
      inpaint,
      dispose: vi.fn(async () => undefined),
    };
    const page = makePage();
    const firstBlock = page.blocks[0];
    if (!firstBlock) throw new Error("expected block");
    page.blocks.push({
      ...structuredClone(firstBlock),
      id: "block-2",
      bbox: { x: 0, y: 0, w: 180, h: 180 },
    });
    const { inpaintPatternPage } =
      await import("../src/main/inpainting/patternPage");

    const result = await inpaintPatternPage(page, {
      inpaintingEngine: engine,
    });

    expect(inpaint).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        blocksErased: 1,
        blocksIncomplete: 1,
        erasedBlockIds: ["block-1"],
        incompleteBlockIds: ["block-2"],
        page: expect.objectContaining({
          inpaintedImagePath: expect.stringContaining("pattern-"),
        }),
      }),
    );
    expect(nativeImageMocks.createFromBitmap).toHaveBeenCalledTimes(1);
  });

  it("excludes previously committed targets while retrying incomplete blocks", async () => {
    const inpaint = vi.fn<InpaintingEngine["inpaint"]>(async (bitmap) => {
      const offset = (2 * 32 + 2) * 4;
      bitmap[offset] = 0;
      bitmap[offset + 1] = 0;
      bitmap[offset + 2] = 0;
    });
    const engine: InpaintingEngine = {
      model: "lama-manga",
      runtimePath: "C:\\runtime\\inpaint.exe",
      backend: "cpu",
      runRootDir: "C:\\runtime\\runs",
      inpaint,
      dispose: vi.fn(async () => undefined),
    };
    const page = makePage();
    const firstBlock = page.blocks[0];
    if (!firstBlock) throw new Error("expected block");
    page.blocks.push({
      ...structuredClone(firstBlock),
      id: "block-2",
      bbox: { x: 0, y: 0, w: 180, h: 180 },
    });
    const { inpaintPatternPage } =
      await import("../src/main/inpainting/patternPage");

    const result = await inpaintPatternPage(page, {
      excludedBlockIds: ["block-1"],
      inpaintingEngine: engine,
    });

    expect(result).toEqual(
      expect.objectContaining({
        blocksErased: 1,
        blocksIncomplete: 0,
        erasedBlockIds: ["block-2"],
        incompleteBlockIds: [],
      }),
    );
  });
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: join(testLogDirectory, "page.png"),
    dataUrl: "data:image/png;base64,AA==",
    width: 32,
    height: 32,
    blocks: [
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 250, y: 250, w: 500, h: 500 },
        sourceText: "source",
        translatedText: "translated",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 16,
        lineHeight: 1.2,
        textAlign: "left",
        textColor: "#000000",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
