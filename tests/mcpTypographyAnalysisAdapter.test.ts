import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";

async function fixture(
  mode: "font" | "size" | "font-and-size" = "font-and-size",
) {
  const f = await typographyAnalysisAppFixture();
  const { McpTypographyReadService } =
    await import("../src/main/application/mcpTypographyReadService");
  const { McpTypographyAnalysisService } =
    await import("../src/main/application/mcpTypographyAnalysisService");
  const { createMcpTypographyAnalyzer } =
    await import("../src/main/mcp/mcpTypographyAnalysisAdapter");
  const { readMcpFontCatalog } =
    await import("../src/main/mcp/mcpFontCatalogAdapter");
  const controller = new AbortController();
  const context = {
    id: randomUUID(),
    signal: controller.signal,
    progress: vi.fn(),
    assertAuthorized: () => controller.signal.throwIfAborted(),
  };
  const preparation = new McpTypographyReadService({
    openChapter: f.library.openChapter,
    readCatalog: () => readMcpFontCatalog(f.app.appPaths),
  });
  const options = {
    chapterId: "chapter",
    mode,
    sourceLanguage: "ja",
    targetLanguage: "ko",
    allowOcr: mode !== "size",
    preserveManualFontSize: true,
  };
  const plan = await preparation.preflight(options, context.assertAuthorized);
  const target = {
    ...options,
    snapshot: plan.snapshot,
    catalogSnapshot: plan.catalogSnapshot,
    pages: plan.pages.map(({ pageId, revision }) => ({ pageId, revision })),
    requestId: randomUUID(),
    allowAssetDownloads: mode !== "size",
  };
  const service = new McpTypographyAnalysisService({
    read: f.library.readWorkContextForEdit,
    preparation,
    analyze: createMcpTypographyAnalyzer(f.app, f.runtime),
  });
  return { ...f, context, controller, target, service };
}

it("reuses real raster measurement and C23 input conversion without modifying saved pages or originals", async () => {
  const f = await fixture();
  const before = await readFile(f.chapterPath);
  try {
    const result = await f.service.run(f.target, f.context);
    expect(result.typographyAnalysis.pages).toHaveLength(2);
    for (const page of result.typographyAnalysis.pages) {
      expect(page.items[0].estimate?.facePx).toBeGreaterThanOrEqual(6);
      expect(page.items[0].font?.fontId).toBe("jua");
      expect(page.items[1].estimate).toBeNull();
      expect(page.items[1].sizeExclusion).toBe("manual_font_size_preserved");
    }
    const [inputs] = f.prepare.mock.calls[0];
    expect(inputs.map((entry) => entry.page.id)).toEqual(["page", "second"]);
    expect(inputs[0].items[0].bbox).toEqual({ x: 100, y: 200, w: 300, h: 300 });
    expect(inputs[0].pageOptions).toMatchObject({
      sourceLanguage: "ja",
      targetLanguage: "ko",
      ocrCpuWorkers: 1,
      autoFontMatching: true,
    });
    expect(await readFile(f.chapterPath)).toEqual(before);
    for (const page of f.chapter.pages)
      expect(await readFile(page.imagePath)).toEqual(f.bytes);
    expect(JSON.stringify(result)).not.toMatch(
      /imagePath|sourceText|translatedText|runDir|PRIVATE/,
    );
  } finally {
    await f.close();
  }
});

it("never invokes the font/OCR engine in multi-page size mode", async () => {
  const f = await fixture("size");
  try {
    const result = await f.service.run(f.target, f.context);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(result.typographyAnalysis.pages[0].items[0].estimate).not.toBeNull();
    expect(result.performed).toEqual(["source_size_measurement"]);
  } finally {
    await f.close();
  }
});

it("does not report a usable font when the C23 choice is not installed", async () => {
  const f = await fixture("font");
  f.prepare.mockResolvedValueOnce(() => ({
    fontId: "missing-font",
    fontWeight: 400,
    italic: false,
    groupId: "group",
    runtimeVersion: "c23.0",
  }));
  try {
    const result = await f.service.run(f.target, f.context);
    expect(result.typographyAnalysis.pages[0].items[0]).toMatchObject({
      font: null,
      fontExclusion: "no_available_c23_candidate",
      estimate: null,
      sizeExclusion: "not_requested",
    });
  } finally {
    await f.close();
  }
});

it("detects original-byte changes while the source font engine runs", async () => {
  const f = await fixture();
  f.prepare.mockImplementationOnce(async () => {
    const changed = new PNG({ width: 100, height: 100 });
    changed.data.fill(240);
    await writeFile(f.chapter.pages[0].imagePath, PNG.sync.write(changed));
    return () => ({
      fontId: "jua",
      fontWeight: 400,
      italic: false,
      groupId: "group",
      runtimeVersion: "c23.0",
    });
  });
  try {
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({
      code: "revision_conflict",
    });
  } finally {
    await f.close();
  }
});

it("does not publish choices after cancellation or an empty model result", async () => {
  const f = await fixture("font");
  try {
    f.prepare.mockResolvedValueOnce(undefined);
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    f.prepare.mockImplementationOnce(async () => {
      f.controller.abort();
      return undefined;
    });
    await expect(f.service.run(f.target, f.context)).rejects.toThrow();
  } finally {
    await f.close();
  }
});
