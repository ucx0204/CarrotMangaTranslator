import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBubbleLayoutBlockRevision } from "../src/main/bubbleLayout/bubbleLayoutPageProcessor";
import type { BubbleLayout } from "../src/shared/bubbleLayout";
import type { MangaPage } from "../src/shared/libraryTypes";

const bubbleRuntimeMocks = vi.hoisted(() => ({
  detectComicPageLayout: vi.fn(),
  ensureComicBubbleDetectorAssets: vi.fn(),
}));

vi.mock("../src/main/bubbleLayout/assets", () => ({
  ensureComicBubbleDetectorAssets:
    bubbleRuntimeMocks.ensureComicBubbleDetectorAssets,
}));

vi.mock("../src/main/bubbleLayout/detector", () => ({
  detectComicPageLayout: bubbleRuntimeMocks.detectComicPageLayout,
}));

vi.mock("../src/main/logger", () => ({
  logWarn: vi.fn(),
}));

const temporaryRoots: string[] = [];

beforeEach(() => {
  bubbleRuntimeMocks.ensureComicBubbleDetectorAssets.mockReset();
  bubbleRuntimeMocks.ensureComicBubbleDetectorAssets.mockRejectedValue(
    new Error("detector unavailable"),
  );
  bubbleRuntimeMocks.detectComicPageLayout.mockReset();
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("production bubble layout failure fallback", () => {
  it("passes the verified model and WASM runtime paths to the detector", async () => {
    const files = await createPageFiles();
    const page = makePage(files.original, files.cleaned);
    const detectorAssets = {
      modelPath: join(files.root, "model.onnx"),
      wasmBinaryPath: join(files.root, "ort.wasm"),
      wasmModulePath: join(files.root, "ort.mjs"),
    };
    bubbleRuntimeMocks.ensureComicBubbleDetectorAssets.mockResolvedValue(
      detectorAssets,
    );
    bubbleRuntimeMocks.detectComicPageLayout.mockRejectedValue(
      new Error("stop after forwarding"),
    );
    const { createProductionBubbleLayoutRunner } =
      await import("../src/main/bubbleLayout/bubbleLayoutFacade");
    const runner = createProductionBubbleLayoutRunner({
      dataRoot: files.root,
    });
    const signal = new AbortController().signal;

    await runner.runPage({
      imagePath: files.cleaned,
      page,
      policy: "balanced",
      signal,
    });

    expect(
      bubbleRuntimeMocks.ensureComicBubbleDetectorAssets,
    ).toHaveBeenCalledWith({
      dataRoot: files.root,
      signal,
    });
    expect(bubbleRuntimeMocks.detectComicPageLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        imagePath: files.original,
        ...detectorAssets,
        signal,
      }),
    );
  });

  it("preserves a current generated layout but clears it after the image changes", async () => {
    const files = await createPageFiles();
    const page = makePage(files.original, files.cleaned);
    const block = page.blocks[0];
    const revision = await resolvePageRevision(files.original, files.cleaned);
    block.bubbleLayout = makeDetectedLayout(
      resolveBubbleLayoutBlockRevision(revision, block),
    );
    const { createProductionBubbleLayoutRunner } =
      await import("../src/main/bubbleLayout/bubbleLayoutFacade");
    const runner = createProductionBubbleLayoutRunner({
      dataRoot: files.root,
    });

    const current = await runner.runPage({
      imagePath: files.cleaned,
      page,
      policy: "balanced",
      signal: new AbortController().signal,
    });
    expect(current.patches).toEqual([]);

    await writeFile(files.cleaned, "changed-cleaned-image", "utf8");
    const stale = await runner.runPage({
      imagePath: files.cleaned,
      page,
      policy: "balanced",
      signal: new AbortController().signal,
    });
    expect(stale.patches).toEqual([
      {
        blockId: block.id,
        renderBbox: null,
        renderBboxSpace: null,
        bubbleLayout: null,
      },
    ]);
  });

  it("never stale-clears explicitly manual geometry", async () => {
    const files = await createPageFiles();
    const page = makePage(files.original, files.cleaned);
    const block = page.blocks[0];
    block.bubbleLayout = {
      ...makeDetectedLayout("unused"),
      origin: "manual",
      // Even a misleading legacy-looking producer id cannot override origin.
      modelId: "comic-rtdetr-manual-tool",
      sourceImageRevision: undefined,
    };
    const { createProductionBubbleLayoutRunner } =
      await import("../src/main/bubbleLayout/bubbleLayoutFacade");
    const runner = createProductionBubbleLayoutRunner({
      dataRoot: files.root,
    });

    const result = await runner.runPage({
      imagePath: files.cleaned,
      page,
      policy: "balanced",
      signal: new AbortController().signal,
    });

    expect(result.patches).toEqual([]);
  });
});

async function createPageFiles(): Promise<{
  root: string;
  original: string;
  cleaned: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bubble-layout-facade-"));
  temporaryRoots.push(root);
  const original = join(root, "page.png");
  const cleaned = join(root, "page.inpainted.png");
  await Promise.all([
    writeFile(original, "original-image", "utf8"),
    writeFile(cleaned, "cleaned-image", "utf8"),
  ]);
  return { root, original, cleaned };
}

async function resolvePageRevision(
  originalPath: string,
  cleanedPath: string,
): Promise<string> {
  const [original, cleaned] = await Promise.all([
    stat(originalPath),
    stat(cleanedPath),
  ]);
  return createHash("sha256")
    .update(
      `${originalPath}:${original.size}:${original.mtimeMs}:${cleanedPath}:${cleaned.size}:${cleaned.mtimeMs}`,
    )
    .digest("hex");
}

function makePage(imagePath: string, inpaintedImagePath: string): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath,
    inpaintedImagePath,
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 100, y: 120, w: 240, h: 260 },
        sourceText: "source",
        translatedText: "translation",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 20,
        lineHeight: 1.2,
        textAlign: "center",
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

function makeDetectedLayout(sourceImageRevision: string): BubbleLayout {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.9,
    origin: "detected",
    modelId:
      "comic-rtdetr-v4-s-int8+safe-distance-v2-overlap-fragment-guard-v3",
    sourceImageRevision,
    insetRatio: 0.05,
    regions: [
      {
        spans: [
          {
            blockStart: 0.05,
            blockEnd: 0.95,
            inlineStart: 0.1,
            inlineEnd: 0.9,
          },
        ],
      },
    ],
  };
}
