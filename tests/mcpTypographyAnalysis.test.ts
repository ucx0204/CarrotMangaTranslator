import { expect, it } from "vitest";
import { McpTypographyAnalysisObservationSchema } from "../src/shared/mcpTypographyAnalysis";
import { typographyAnalysisFixture } from "./mcpTypographyAnalysis.fixture";

it("returns a fixed, bounded observation without page writes, texts, images or file paths", async () => {
  const f = typographyAnalysisFixture();
  const before = structuredClone(f.saved);
  const request = await f.target();
  const result = await f.service.run(request, f.context);
  expect(result).toMatchObject({
    status: "observed",
    pagesChanged: 0,
    engine: "app-c23",
  });
  expect(result.performed).toEqual([
    "source_size_measurement",
    "hayai_source_verification",
    "c23_font_selection",
  ]);
  expect(result.typographyAnalysis.expiresAt).toBe(1801000);
  expect(result.typographyAnalysis.pages.map((page) => page.pageId)).toEqual([
    "page",
    "second",
    "third",
  ]);
  expect(
    McpTypographyAnalysisObservationSchema.safeParse(result.typographyAnalysis)
      .success,
  ).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|private|imagePath|sourceText|translatedText/,
  );
  expect(f.analyze).toHaveBeenCalledOnce();
  expect(f.save).not.toHaveBeenCalled();
  expect(f.saved).toEqual(before);
});

it("does not require OCR or downloads for size-only analysis", async () => {
  const f = typographyAnalysisFixture();
  const request = await f.target({
    mode: "size",
    allowOcr: false,
    sourceLanguage: "en",
    targetLanguage: "en",
  });
  request.allowAssetDownloads = false;
  const result = await f.service.run(request, f.context);
  expect(result.engine).toBe("app-source-raster");
  expect(result.performed).toEqual(["source_size_measurement"]);
  expect(
    result.typographyAnalysis.pages.every((page) =>
      page.items.every((item) => item.font === null),
    ),
  ).toBe(true);
});

it.each(["ocr", "download", "language", "empty"])(
  "does not start analysis when %s prerequisites fail",
  async (kind) => {
    const f = typographyAnalysisFixture();
    if (kind === "empty")
      f.chapter.pages.forEach((page) => {
        page.blocks = [];
      });
    const request = await f.target({
      allowOcr: kind !== "ocr",
      sourceLanguage: kind === "language" ? "en" : "ja",
    });
    if (kind === "download") request.allowAssetDownloads = false;
    await expect(f.service.run(request, f.context)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    expect(f.analyze).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  },
);

it.each(["snapshot", "catalog", "revision", "order", "duplicate"])(
  "refuses stale or ambiguous %s before analysis",
  async (kind) => {
    const f = typographyAnalysisFixture();
    const request = await f.target();
    if (kind === "snapshot") request.snapshot = "0".repeat(16);
    if (kind === "catalog") f.changeCatalog();
    if (kind === "revision")
      request.pages[0].revision = "page-v1:0000000000000000";
    if (kind === "order") request.pages.reverse();
    if (kind === "duplicate") request.pages[1] = request.pages[0];
    await expect(f.service.run(request, f.context)).rejects.toThrow();
    expect(f.analyze).not.toHaveBeenCalled();
  },
);

it.each(["page", "context", "membership", "catalog"])(
  "rejects %s changes during analysis",
  async (kind) => {
    const f = typographyAnalysisFixture();
    const request = await f.target();
    f.analyze.mockImplementationOnce(async (input, context) => {
      const result = await f.observe(input, context);
      if (kind === "page") f.chapter.pages[0].blocks[0].sourceText = "changed";
      if (kind === "context") f.saved.styleGuide.rules.honorifics = "drop";
      if (kind === "membership") f.chapter.pageOrder.reverse();
      if (kind === "catalog") f.changeCatalog();
      return result;
    });
    await expect(f.service.run(request, f.context)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.save).not.toHaveBeenCalled();
  },
);

it("rejects mismatched context membership before dispatch", async () => {
  const f = typographyAnalysisFixture();
  const request = await f.target();
  f.saved.workId = "other";
  await expect(f.service.run(request, f.context)).rejects.toMatchObject({
    code: "not_found",
  });
  expect(f.analyze).not.toHaveBeenCalled();
});

it("records manual size and generated-image exclusions without losing their stored state", async () => {
  const f = typographyAnalysisFixture();
  f.chapter.pages[0].blocks[0].fontSizeIntent = "manual";
  f.chapter.pages[1].blocks[0].generatedLettering = {
    version: 1,
    dataUrl: "PRIVATE",
    sourceText: "x",
    translatedText: "y",
  };
  const before = structuredClone(f.saved);
  const result = await f.service.run(await f.target(), f.context);
  expect(result.typographyAnalysis.pages[0].items[0]).toMatchObject({
    estimate: null,
    sizeExclusion: "manual_font_size_preserved",
  });
  expect(result.typographyAnalysis.pages[1].items[0]).toMatchObject({
    font: null,
    estimate: null,
    fontExclusion: "generated_lettering",
  });
  expect(f.saved).toEqual(before);
});

it.each(["page", "block", "font-evidence", "size-evidence", "missing-reason"])(
  "refuses inconsistent %s in engine output",
  async (kind) => {
    const f = typographyAnalysisFixture();
    const request = await f.target();
    f.analyze.mockImplementationOnce(async (input, context) => {
      const result = await f.observe(input, context);
      const item = result.pages[0].items[0];
      if (kind === "page") result.pages.reverse();
      if (kind === "block") item.blockId = "other";
      if (kind === "font-evidence") item.fontExclusion = "excluded";
      if (kind === "size-evidence") item.sizeExclusion = "excluded";
      if (kind === "missing-reason") {
        item.font = null;
        item.fontExclusion = null;
      }
      return result;
    });
    await expect(f.service.run(request, f.context)).rejects.toMatchObject({
      code: "invalid_edit",
    });
  },
);

it("supports abstention instead of inventing measurements", async () => {
  const f = typographyAnalysisFixture();
  f.analyze.mockImplementationOnce(async (input, context) => {
    const result = await f.observe(input, context);
    result.pages[0].items[0] = {
      blockId: "a",
      font: null,
      estimate: null,
      fontExclusion: "insufficient_evidence",
      sizeExclusion: "insufficient_raster_evidence",
    };
    return result;
  });
  const result = await f.service.run(await f.target(), f.context);
  expect(result.typographyAnalysis.pages[0].items[0].font).toBeNull();
});

it.each(["before", "during"])(
  "honors cancellation %s execution",
  async (when) => {
    const f = typographyAnalysisFixture();
    const request = await f.target();
    if (when === "before") f.controller.abort();
    else
      f.analyze.mockImplementationOnce(async (input, context) => {
        const result = await f.observe(input, context);
        f.controller.abort();
        return result;
      });
    await expect(f.service.run(request, f.context)).rejects.toThrow();
    if (when === "before") expect(f.analyze).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  },
);

it("preserves engine and storage failures rather than producing successful empty observations", async () => {
  const f = typographyAnalysisFixture();
  const request = await f.target();
  const engineError = new AggregateError([
    new Error("engine"),
    new Error("cleanup"),
  ]);
  f.analyze.mockRejectedValueOnce(engineError);
  await expect(f.service.run(request, f.context)).rejects.toBe(engineError);
  f.read.mockRejectedValueOnce(new Error("storage"));
  await expect(f.service.run(request, f.context)).rejects.toThrow("storage");
  expect(f.save).not.toHaveBeenCalled();
});

it("does not claim a size measurement stage when every size is manually protected", async () => {
  const f = typographyAnalysisFixture();
  for (const page of f.chapter.pages)
    for (const block of page.blocks) block.fontSizeIntent = "manual";
  const result = await f.service.run(await f.target(), f.context);
  expect(result.performed).toEqual([
    "hayai_source_verification",
    "c23_font_selection",
  ]);
  expect(
    result.typographyAnalysis.pages.every((page) =>
      page.items.every((item) => item.estimate === null),
    ),
  ).toBe(true);
});
