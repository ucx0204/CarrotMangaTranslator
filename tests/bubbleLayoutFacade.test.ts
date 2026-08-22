import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBubbleLayoutBlockRevision } from "../src/main/bubbleLayout/bubbleLayoutPageProcessor";
import type { BubbleLayout } from "../src/shared/bubbleLayout";
import type { MangaPage } from "../src/shared/libraryTypes";

const bubbleRuntimeMocks = vi.hoisted(() => ({
  detectKoharuPageLayout: vi.fn(),
  ensureKoharuLayoutAssets: vi.fn(),
}));

vi.mock("../src/main/bubbleLayout/assets", () => ({
  ensureKoharuLayoutAssets: bubbleRuntimeMocks.ensureKoharuLayoutAssets,
}));

vi.mock("../src/main/bubbleLayout/detector", () => ({
  detectKoharuPageLayout: bubbleRuntimeMocks.detectKoharuPageLayout,
}));

vi.mock("../src/main/logger", () => ({
  logWarn: vi.fn(),
}));

const temporaryRoots: string[] = [];

beforeEach(() => {
  bubbleRuntimeMocks.ensureKoharuLayoutAssets.mockReset();
  bubbleRuntimeMocks.ensureKoharuLayoutAssets.mockRejectedValue(
    new Error("detector unavailable"),
  );
  bubbleRuntimeMocks.detectKoharuPageLayout.mockReset();
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("production bubble layout failure fallback", () => {
  it("reuses original-page detector output across mask and final layout passes", async () => {
    const files = await createPageFiles();
    const finalPage = makePage(files.original, files.cleaned);
    const prepassPage = structuredClone(finalPage);
    delete prepassPage.inpaintedImagePath;
    const detectorAssets = {
      modelPath: join(files.root, "model.onnx"),
    };
    bubbleRuntimeMocks.ensureKoharuLayoutAssets.mockResolvedValue(
      detectorAssets,
    );
    bubbleRuntimeMocks.detectKoharuPageLayout.mockResolvedValue({
      imageWidth: 4,
      imageHeight: 4,
      detections: [],
    });
    const { createProductionBubbleLayoutRunner } =
      await import("../src/main/bubbleLayout/bubbleLayoutFacade");
    const runner = createProductionBubbleLayoutRunner({
      dataRoot: files.root,
    });
    const signal = new AbortController().signal;

    const prepass = await runner.runPage({
      failureMode: "best-effort",
      includeTypographySegmentation: true,
      imagePath: files.original,
      page: prepassPage,
      paddingRatio: 0,
      policy: "balanced",
      signal,
    });
    await runner.runPage({
      imagePath: files.cleaned,
      page: finalPage,
      paddingRatio: 0.12,
      policy: "balanced",
      signal,
    });

    expect(bubbleRuntimeMocks.ensureKoharuLayoutAssets).toHaveBeenCalledTimes(
      1,
    );
    expect(bubbleRuntimeMocks.detectKoharuPageLayout).toHaveBeenCalledTimes(1);
    expect(prepass.typographySegmentation).toEqual({
      imageWidth: 4,
      imageHeight: 4,
      detections: [],
    });
    expect(bubbleRuntimeMocks.detectKoharuPageLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        imagePath: files.original,
        ...detectorAssets,
      }),
    );
  });

  it("retries final detection after a transient prepass failure", async () => {
    const files = await createPageFiles();
    const finalPage = makePage(files.original, files.cleaned);
    const prepassPage = structuredClone(finalPage);
    delete prepassPage.inpaintedImagePath;
    bubbleRuntimeMocks.ensureKoharuLayoutAssets.mockResolvedValue({
      modelPath: join(files.root, "model.onnx"),
    });
    bubbleRuntimeMocks.detectKoharuPageLayout
      .mockRejectedValueOnce(new Error("transient detector failure"))
      .mockResolvedValueOnce({
        imageWidth: 4,
        imageHeight: 4,
        detections: [],
      });
    const { createProductionBubbleLayoutRunner } =
      await import("../src/main/bubbleLayout/bubbleLayoutFacade");
    const runner = createProductionBubbleLayoutRunner({
      dataRoot: files.root,
    });
    const signal = new AbortController().signal;

    await runner.runPage({
      failureMode: "best-effort",
      imagePath: files.original,
      page: prepassPage,
      paddingRatio: 0,
      policy: "balanced",
      signal,
    });
    await runner.runPage({
      imagePath: files.cleaned,
      page: finalPage,
      paddingRatio: 0.12,
      policy: "balanced",
      signal,
    });

    expect(bubbleRuntimeMocks.detectKoharuPageLayout).toHaveBeenCalledTimes(2);
  });

  it("passes only the verified Koharu model path to the detector", async () => {
    const files = await createPageFiles();
    const page = makePage(files.original, files.cleaned);
    const detectorAssets = {
      modelPath: join(files.root, "model.onnx"),
    };
    bubbleRuntimeMocks.ensureKoharuLayoutAssets.mockResolvedValue(
      detectorAssets,
    );
    bubbleRuntimeMocks.detectKoharuPageLayout.mockRejectedValue(
      new Error("stop after forwarding"),
    );
    const { createProductionBubbleLayoutRunner } =
      await import("../src/main/bubbleLayout/bubbleLayoutFacade");
    const runner = createProductionBubbleLayoutRunner({
      dataRoot: files.root,
    });
    const signal = new AbortController().signal;

    await runner.runPage({
      failureMode: "best-effort",
      imagePath: files.cleaned,
      page,
      policy: "balanced",
      signal,
    });

    expect(bubbleRuntimeMocks.ensureKoharuLayoutAssets).toHaveBeenCalledWith({
      dataRoot: files.root,
      signal,
    });
    expect(bubbleRuntimeMocks.detectKoharuPageLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        imagePath: files.original,
        ...detectorAssets,
        signal,
      }),
    );
  });

  it("defaults an unspecified failure mode to required", async () => {
    const files = await createPageFiles();
    const page = makePage(files.original, files.cleaned);
    const { createProductionBubbleLayoutRunner } =
      await import("../src/main/bubbleLayout/bubbleLayoutFacade");
    const runner = createProductionBubbleLayoutRunner({
      dataRoot: files.root,
    });

    await expect(
      runner.runPage({
        imagePath: files.cleaned,
        page,
        policy: "balanced",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("detector unavailable");
  });

  it("preserves cancellation instead of treating it as a detector fallback", async () => {
    const files = await createPageFiles();
    const controller = new AbortController();
    controller.abort();
    const { createProductionBubbleLayoutRunner } =
      await import("../src/main/bubbleLayout/bubbleLayoutFacade");
    const runner = createProductionBubbleLayoutRunner({ dataRoot: files.root });

    await expect(
      runner.runPage({
        failureMode: "best-effort",
        imagePath: files.cleaned,
        page: makePage(files.original, files.cleaned),
        policy: "balanced",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
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
      failureMode: "best-effort",
      imagePath: files.cleaned,
      page,
      policy: "balanced",
      signal: new AbortController().signal,
    });
    expect(current.patches).toEqual([]);

    await writeFile(files.cleaned, "changed-cleaned-image", "utf8");
    const stale = await runner.runPage({
      failureMode: "best-effort",
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
      failureMode: "best-effort",
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
