import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
      sourceEvidenceMode: "required",
    });

    expect(inpaint).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      page,
      blocksErased: 0,
      blocksIncomplete: 1,
      erasedBlockIds: [],
      incompleteBlockIds: ["block-1"],
      residualDiagnostics: [
        expect.objectContaining({
          blockId: "block-1",
          sourceSeedCount: 0,
          residualVeto: false,
        }),
      ],
      sourceEvidenceReceipt: expect.objectContaining({
        diagnosticOnly: true,
        promotionEligible: false,
        sealed: false,
        blocksById: { "block-1": expect.any(Object) },
      }),
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

  it("adds an explicitly targeted pass to the existing inpainted image", async () => {
    const originalBitmap = Buffer.alloc(32 * 32 * 4, 255);
    const dialogueCleanBitmap = Buffer.from(originalBitmap);
    const preservedOffset = (2 * 32 + 2) * 4;
    dialogueCleanBitmap[preservedOffset] = 41;
    dialogueCleanBitmap[preservedOffset + 1] = 42;
    dialogueCleanBitmap[preservedOffset + 2] = 43;
    const engine: InpaintingEngine = {
      model: "lama-manga",
      runtimePath: "C:\\runtime\\inpaint.exe",
      backend: "cpu",
      runRootDir: "C:\\runtime\\runs",
      inpaint: vi.fn(async (bitmap) => {
        const targetOffset = (16 * 32 + 16) * 4;
        bitmap[targetOffset] = 0;
        bitmap[targetOffset + 1] = 0;
        bitmap[targetOffset + 2] = 0;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const page = makePage();
    page.inpaintedImagePath = join(testLogDirectory, "dialogue-clean.png");
    page.translationCompletion = {
      workflow: "erase-original",
      status: "pending",
    };
    nativeImageMocks.createFromPath.mockImplementation((filePath: string) => ({
      getSize: () => ({ width: 32, height: 32 }),
      isEmpty: () => false,
      toBitmap: () =>
        Buffer.from(
          filePath === page.inpaintedImagePath
            ? dialogueCleanBitmap
            : originalBitmap,
        ),
    }));
    const { inpaintPatternPage } =
      await import("../src/main/inpainting/patternPage");

    await inpaintPatternPage(page, {
      blockIds: ["block-1"],
      inpaintingEngine: engine,
      preserveExistingInpainting: true,
    });

    expect(nativeImageMocks.createFromPath).toHaveBeenNthCalledWith(
      1,
      page.inpaintedImagePath,
    );
    const outputBitmap = nativeImageMocks.createFromBitmap.mock.calls[0]?.[0];
    expect(
      outputBitmap?.subarray(preservedOffset, preservedOffset + 3),
    ).toEqual(Buffer.from([41, 42, 43]));
  });

  it("seals retry evidence against the immutable original bitmap and asset", async () => {
    const page = makePage();
    const cleanedPath = join(testLogDirectory, "retry-cleaned.png");
    const sourceBytes = Buffer.from("sealed-original-image-bytes");
    const cleanedBytes = Buffer.from("sealed-retry-cleaned-bytes");
    writeFileSync(page.imagePath, sourceBytes);
    writeFileSync(cleanedPath, cleanedBytes);
    page.inpaintedImagePath = cleanedPath;
    page.translationCompletion = {
      workflow: "bubble-layout",
      status: "pending",
      erasedBlockIds: ["block-1"],
    };
    const originalBitmap = Buffer.alloc(32 * 32 * 4, 255);
    fillRect(originalBitmap, 32, { x: 12, y: 9, w: 8, h: 15 }, 8);
    const cleanedBitmap = Buffer.alloc(32 * 32 * 4, 255);
    nativeImageMocks.createFromPath.mockImplementation((filePath: string) => ({
      getSize: () => ({ width: 32, height: 32 }),
      isEmpty: () => false,
      toBitmap: () =>
        Buffer.from(
          filePath === page.imagePath ? originalBitmap : cleanedBitmap,
        ),
    }));
    const engine: InpaintingEngine = {
      model: "lama-manga",
      runtimePath: "C:\\runtime\\inpaint.exe",
      backend: "cpu",
      runRootDir: "C:\\runtime\\runs",
      inpaint: vi.fn(async (target) => {
        const offset = (16 * 32 + 16) * 4;
        target[offset] = 0;
        target[offset + 1] = 0;
        target[offset + 2] = 0;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const { inpaintPatternPage } =
      await import("../src/main/inpainting/patternPage");

    const result = await inpaintPatternPage(page, {
      inpaintingEngine: engine,
      sourceEvidenceMode: "required",
    });

    expect(result.sourceEvidenceReceipt).toMatchObject({
      sealed: true,
      source: {
        assetPath: page.imagePath,
        assetSha256: sha256(sourceBytes),
        baselineKind: "immutable-original",
      },
      before: {
        assetPath: cleanedPath,
        assetSha256: sha256(cleanedBytes),
        baselineKind: "retry-cleaned",
      },
      after: {
        cleanedAssetSha256: sha256(Buffer.from("png")),
      },
      blocksById: {
        "block-1": expect.objectContaining({
          blockId: "block-1",
          firstPassCoreSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          sourceEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      },
    });
    expect(result.residualDiagnostics?.[0]?.sourceSeedCount).toBeGreaterThan(0);
  });

  it("keeps source-glyph residue diagnostic-only when pixels changed", async () => {
    const bitmap = Buffer.alloc(32 * 32 * 4, 255);
    fillRect(bitmap, 32, { x: 12, y: 9, w: 8, h: 15 }, 8);
    fillRect(bitmap, 32, { x: 9, y: 14, w: 14, h: 7 }, 8);
    nativeImageMocks.createFromPath.mockReturnValue({
      getSize: () => ({ width: 32, height: 32 }),
      isEmpty: () => false,
      toBitmap: () => Buffer.from(bitmap),
    });
    const inpaint = vi.fn<InpaintingEngine["inpaint"]>(async (target) => {
      const offset = (16 * 32 + 16) * 4;
      target[offset] = 255;
      target[offset + 1] = 255;
      target[offset + 2] = 255;
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
    writeFileSync(page.imagePath, Buffer.from("diagnostic-source-image"));
    const { inpaintPatternPage } =
      await import("../src/main/inpainting/patternPage");

    const result = await inpaintPatternPage(page, {
      inpaintingEngine: engine,
      sourceEvidenceMode: "required",
    });

    expect(result).toEqual(
      expect.objectContaining({
        blocksErased: 1,
        blocksIncomplete: 0,
        erasedBlockIds: ["block-1"],
        incompleteBlockIds: [],
        page: expect.objectContaining({
          inpaintedImagePath: expect.stringContaining("pattern-"),
        }),
        residualDiagnostics: [
          expect.objectContaining({
            blockId: "block-1",
            diagnosticOnly: true,
            promotionEligible: false,
            resolutionNormalized: false,
            sourceSeedCount: expect.any(Number),
            sourceLikeRemainingRatio: expect.any(Number),
            residualVeto: true,
          }),
        ],
      }),
    );
    expect(
      result.residualDiagnostics?.[0]?.sourceSeedCount,
    ).toBeGreaterThanOrEqual(24);
    expect(nativeImageMocks.createFromBitmap).toHaveBeenCalledTimes(1);
  });

  it("keeps production retry output available when immutable diagnostics are unavailable", async () => {
    const fixtureDir = mkdtempSync(
      join(testLogDirectory, "strict-output-cleanup-"),
    );
    const pagesDir = join(fixtureDir, "pages");
    const inpaintedDir = join(fixtureDir, "inpainted");
    mkdirSync(pagesDir, { recursive: true });
    mkdirSync(inpaintedDir, { recursive: true });
    const page = makePage();
    page.imagePath = join(pagesDir, "missing-original-production.png");
    const cleanedPath = join(inpaintedDir, "production-retry-cleaned.png");
    writeFileSync(cleanedPath, Buffer.from("production-retry-cleaned"));
    page.inpaintedImagePath = cleanedPath;
    const firstBlock = page.blocks[0];
    if (!firstBlock) throw new Error("expected source block");
    page.blocks.push({
      ...structuredClone(firstBlock),
      id: "already-erased",
      inpaintExcluded: true,
    });
    page.translationCompletion = {
      workflow: "bubble-layout",
      status: "pending",
      erasedBlockIds: ["already-erased"],
    };
    const cleanedBitmap = Buffer.alloc(32 * 32 * 4, 255);
    nativeImageMocks.createFromPath.mockImplementation((filePath: string) => {
      if (filePath === page.imagePath) {
        throw new Error("immutable original unavailable");
      }
      return {
        getSize: () => ({ width: 32, height: 32 }),
        isEmpty: () => false,
        toBitmap: () => Buffer.from(cleanedBitmap),
      };
    });
    const engine: InpaintingEngine = {
      model: "lama-manga",
      runtimePath: "C:\\runtime\\inpaint.exe",
      backend: "cpu",
      runRootDir: "C:\\runtime\\runs",
      inpaint: vi.fn(async (target) => {
        const offset = (16 * 32 + 16) * 4;
        target[offset] = 0;
        target[offset + 1] = 0;
        target[offset + 2] = 0;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const { inpaintPatternPage } =
      await import("../src/main/inpainting/patternPage");

    const result = await inpaintPatternPage(page, {
      inpaintingEngine: engine,
    });

    expect(result).toMatchObject({
      blocksErased: 1,
      blocksIncomplete: 0,
      erasedBlockIds: ["block-1"],
      incompleteBlockIds: [],
      page: {
        inpaintedImagePath: expect.stringContaining("pattern-"),
        inpaintMaskPath: expect.stringContaining("pattern-"),
        maskProvenance: "derived-diff",
      },
    });
    expect(result).not.toHaveProperty("residualDiagnostics");
    expect(result).not.toHaveProperty("sourceEvidenceReceipt");
    expect(nativeImageMocks.createFromPath).toHaveBeenCalledTimes(2);
    expect(nativeImageMocks.createFromPath).toHaveBeenNthCalledWith(
      1,
      cleanedPath,
    );
    expect(nativeImageMocks.createFromPath).toHaveBeenNthCalledWith(
      2,
      page.imagePath,
    );
    expect(nativeImageMocks.createFromBitmap).toHaveBeenCalledTimes(1);
    const productionOutputPath = result.page.inpaintedImagePath;
    if (!productionOutputPath) throw new Error("expected production output");
    const productionMetadataPath = `${productionOutputPath}.mgtmeta.json`;
    writeFileSync(productionMetadataPath, "existing-metadata", "utf8");

    vi.clearAllMocks();
    await expect(
      inpaintPatternPage(page, {
        inpaintingEngine: engine,
        sourceEvidenceMode: "required",
      }),
    ).rejects.toThrow("immutable original unavailable");
    expect(nativeImageMocks.createFromPath).toHaveBeenNthCalledWith(
      1,
      cleanedPath,
    );
    expect(nativeImageMocks.createFromPath).toHaveBeenNthCalledWith(
      2,
      page.imagePath,
    );
    expect(nativeImageMocks.createFromBitmap).toHaveBeenCalledTimes(1);
    expect(existsSync(cleanedPath)).toBe(true);
    expect(existsSync(productionOutputPath)).toBe(true);
    expect(existsSync(productionMetadataPath)).toBe(true);
    expect(
      readdirSync(inpaintedDir).filter(
        (name) => name.startsWith("pattern-") && name.endsWith(".png"),
      ),
    ).toEqual([basename(productionOutputPath)]);
  });

  it("binds strict output cleanup failure to the original diagnostic failure", async () => {
    const diagnosticError = new Error("strict receipt failed");
    const cleanupError = new Error("output removal failed");
    const outputPath = join(testLogDirectory, "generated-pattern.png");
    const { cleanupStrictDiagnosticOutput } =
      await import("../src/main/inpainting/patternPageSourceDiagnostics");

    await expect(
      cleanupStrictDiagnosticOutput(outputPath, diagnosticError, async () => {
        throw cleanupError;
      }),
    ).rejects.toMatchObject({
      code: "inpainting.strictDiagnosticOutputCleanupFailed",
      generatedOutputPath: outputPath,
      errors: [diagnosticError, cleanupError],
    });
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

function fillRect(
  bitmap: Buffer,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * width + x) * 4;
      bitmap[offset] = value;
      bitmap[offset + 1] = value;
      bitmap[offset + 2] = value;
      bitmap[offset + 3] = 255;
    }
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
