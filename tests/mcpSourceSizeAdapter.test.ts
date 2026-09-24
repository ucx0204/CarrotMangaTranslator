import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import { editingChapter } from "./mcpEditing.fixture";

async function fixture() {
  const env = await mcpAppEnvironment();
  const { measureMcpSourceSizes } =
    await import("../src/main/mcp/mcpSourceSizeAdapter");
  const page = editingChapter().pages[0];
  page.imagePath = join(env.root, "original.png");
  page.width = 100;
  page.height = 100;
  const block = page.blocks[0];
  Object.assign(block, {
    textRole: "ordinary",
    sourceText: "あ",
    sourceDirection: "horizontal",
    bbox: { x: 10, y: 20, w: 30, h: 30 },
    bboxSpace: "pixels",
  });
  delete block.generatedLettering;
  const png = new PNG({ width: 100, height: 100 });
  png.data.fill(255);
  for (let y = 25; y < 45; y++)
    for (let x = 15; x < 35; x++)
      png.data.fill(0, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3);
  const original = PNG.sync.write(png);
  await writeFile(page.imagePath, original);
  const controller = new AbortController();
  const context = {
    id: randomUUID(),
    signal: controller.signal,
    progress: vi.fn(),
    assertAuthorized: () => controller.signal.throwIfAborted(),
  };
  // Only native decoding is injected; the app's estimator and filesystem are real.
  const loadRaster = async () => {
    const image = PNG.sync.read(await readFile(page.imagePath));
    return { width: image.width, height: image.height, bgra: image.data };
  };
  return {
    page,
    block,
    original,
    context,
    controller,
    loadRaster,
    measureMcpSourceSizes,
    close: env.close,
  };
}

it("measures the original raster and binds it to its actual bytes without changing the page", async () => {
  const f = await fixture();
  const before = structuredClone(f.page);
  try {
    const result = await f.measureMcpSourceSizes(
      f.page,
      [f.block],
      f.context,
      f.loadRaster,
    );
    expect(result.estimates[0]?.facePx).toBeGreaterThanOrEqual(6);
    expect(result.sourceImageSha256).toBe(
      createHash("sha256").update(f.original).digest("hex"),
    );
    expect(f.page).toEqual(before);
    expect(await readFile(f.page.imagePath)).toEqual(f.original);
  } finally {
    await f.close();
  }
});

it("rejects a source file changed during real raster analysis", async () => {
  const f = await fixture();
  try {
    await expect(
      f.measureMcpSourceSizes(f.page, [f.block], f.context, async () => {
        const raster = await f.loadRaster();
        await writeFile(f.page.imagePath, "changed fixture");
        return raster;
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  } finally {
    await f.close();
  }
});

it("keeps normalized source geometry and reports absent ink without a fallback size", async () => {
  const f = await fixture();
  try {
    f.block.bboxSpace = "normalized_1000";
    f.block.bbox = { x: 100, y: 200, w: 300, h: 300 };
    expect(
      (
        await f.measureMcpSourceSizes(
          f.page,
          [f.block],
          f.context,
          f.loadRaster,
        )
      ).estimates[0]?.facePx,
    ).toBeGreaterThanOrEqual(6);
    const blank = new PNG({ width: 100, height: 100 });
    blank.data.fill(255);
    await writeFile(f.page.imagePath, PNG.sync.write(blank));
    expect(
      (
        await f.measureMcpSourceSizes(
          f.page,
          [f.block],
          f.context,
          f.loadRaster,
        )
      ).estimates,
    ).toEqual([null]);
  } finally {
    await f.close();
  }
});

it("does not return a measurement after cancellation", async () => {
  const f = await fixture();
  try {
    await expect(
      f.measureMcpSourceSizes(f.page, [f.block], f.context, async () => {
        const raster = await f.loadRaster();
        f.controller.abort();
        return raster;
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("rejects malformed single-page executor requests before creating app jobs or page handoffs", async () => {
  const { typographyAnalysisAppFixture } =
    await import("./mcpTypographyAnalysisApp.fixture");
  const f = await typographyAnalysisAppFixture();
  const { createMcpSourceSizeExecutor } =
    await import("../src/main/mcp/mcpSourceSizeAdapter");
  const executor = createMcpSourceSizeExecutor(f.app);
  const context = {
    id: randomUUID(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    assertAuthorized: vi.fn(),
  };
  const before = await readFile(f.chapterPath);
  try {
    expect(() =>
      executor(
        {
          chapterId: "chapter",
          pageId: "page",
          revision: "invalid",
          requestId: randomUUID(),
        },
        context,
      ),
    ).toThrow();
    expect(f.app.jobs.all).toEqual([]);
    expect(f.app.jobs.pageHandoffs.activities).toEqual([]);
    expect(f.handoffPages).toEqual([]);
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
