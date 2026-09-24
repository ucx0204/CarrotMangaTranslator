import { PNG } from "pngjs";
import { expect, it } from "vitest";
import {
  McpPsdExportOptionsSchema,
  McpRasterExportOptionsSchema,
  mcpArtifactMime,
  mcpArtifactName,
} from "../src/shared/mcpOutputFormats";
import { McpExportPagesMetadataSchema } from "../src/shared/mcpExportBatch";
import {
  assertMcpPsdBudget,
  renderMcpPsdInSession,
} from "../src/main/mcp/mcpPsdExport";
import { readExportZip } from "./mcpExportBatch.fixture";
import {
  psdExportFixture,
  psdOptions,
  readPsdPixels,
} from "./mcpPsdExport.fixture";

it("builds actual PSD layers through native assembly and packages exact bytes without rerender", async () => {
  const f = psdExportFixture();
  try {
    const before = structuredClone(f.chapter);
    const result = await f.service.run(
      await f.target(["p1"], psdOptions),
      f.context,
      f.assertRetained,
    );
    expect(result.status).toBe("completed");
    const first = result.exportPages.pages[0];
    expect(first).toMatchObject({
      filename: "0001.psd",
      mimeType: "image/vnd.adobe.photoshop",
    });
    const bytes = await f.file(first);
    expect(bytes.subarray(0, 6)).toEqual(
      Buffer.from([0x38, 0x42, 0x50, 0x53, 0, 1]),
    );
    const parsed = readPsdPixels(bytes);
    expect(parsed.width).toBe(8);
    expect(parsed.height).toBe(8);
    expect(parsed.children?.[0].name).toContain("Original");
    expect(parsed.children?.[1].name).toContain("Inpaint");
    expect(parsed.children?.[2].text?.text).toBe("PSD text 1");
    expect(parsed.children?.[3].text).toBeUndefined();
    expect(parsed.children?.[3].name).toContain("[raster]");
    const original = parsed.children?.[0].imageData;
    const cleaned = parsed.children?.[1].imageData;
    const composite = parsed.imageData;
    if (!original || !cleaned || !composite || !first.mimeType)
      throw new Error("PSD is missing required pixel planes or file identity");
    expect(Buffer.from(original.data)).toEqual(
      PNG.sync.read(f.capture.original).data,
    );
    expect(Buffer.from(cleaned.data)).toEqual(
      PNG.sync.read(f.capture.cleaned).data,
    );
    expect(Buffer.from(composite.data)).toEqual(
      PNG.sync.read(f.capture.composite).data,
    );
    expect(
      f.capture.session.renderPage.mock.calls.every(
        (call) => call[1]?.resolutionMode === "original",
      ),
    ).toBe(true);
    const archive = readExportZip(await f.read((await f.zip(result)).url));
    expect(archive["0001.psd"]).toEqual(bytes);
    expect(JSON.parse(archive["manifest.json"].toString()).imageExport).toEqual(
      psdOptions,
    );
    expect(
      JSON.stringify(McpExportPagesMetadataSchema.parse(result.exportPages)),
    ).not.toMatch(/mcp-artifacts|imagePath|dataUrl/);
    expect(f.renderImage).toHaveBeenCalledOnce();
    expect(f.chapter).toEqual(before);
    expect(mcpArtifactName(first.mimeType)).toBe("page.psd");
    expect(mcpArtifactMime("page.psd")).toBe("image/vnd.adobe.photoshop");
  } finally {
    await f.close();
  }
});

it("requires original-layer and raster-fallback acknowledgment and keeps the raster schema narrow", () => {
  expect(McpPsdExportOptionsSchema.safeParse(psdOptions).success).toBe(true);
  expect(McpRasterExportOptionsSchema.safeParse(psdOptions).success).toBe(
    false,
  );
  for (const patch of [
    { acknowledgeOriginalLayer: false },
    { acknowledgeOriginalLayer: undefined },
    { acknowledgeRasterLayers: false },
    { acknowledgeRasterLayers: undefined },
    { omitText: true },
    { quality: 90 },
    { outputPath: "C:/private" },
    { format: "psb" },
  ])
    expect(
      McpPsdExportOptionsSchema.safeParse({ ...psdOptions, ...patch }).success,
    ).toBe(false);
});

it("preserves completed PSDs on later failure and requires explicit partial ZIP approval", async () => {
  const f = psdExportFixture();
  try {
    f.renderImage.mockImplementation(async (page, signal) => {
      if (page.id === "p2") throw new Error("Injected PSD renderer failure");
      return Buffer.from(
        await renderMcpPsdInSession(page, f.capture.session, signal),
      );
    });
    const result = await f.service.run(
      await f.target(undefined, psdOptions),
      f.context,
      f.assertRetained,
    );
    expect(result.status).toBe("partial");
    expect(result.exportPages.pages.map((page) => page.status)).toEqual([
      "exported",
      "failed",
      "unprocessed",
    ]);
    await expect(f.zip(result)).rejects.toMatchObject({ code: "invalid_edit" });
    const archive = readExportZip(
      await f.read((await f.zip(result, true)).url),
    );
    expect(archive["0001.psd"]).toEqual(
      await f.file(result.exportPages.pages[0]),
    );
    expect(archive["0002.psd"]).toBeUndefined();
    expect(JSON.parse(archive["manifest.json"].toString()).partialOutput).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

it("cancels during native layer capture without publishing a PSD", async () => {
  const f = psdExportFixture();
  try {
    f.capture.session.renderTransparentPage.mockImplementationOnce(async () => {
      f.controller.abort();
      return f.capture.text;
    });
    const result = await f.service.run(
      await f.target(["p1"], psdOptions),
      f.context,
      f.assertRetained,
    );
    expect(result.status).toBe("cancelled");
    expect(result.exportPages.completed).toBe(0);
    expect(result.exportPages.pages[0].url).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("rejects unsupported dimensions, excessive layers and decoded surface volume before capture", async () => {
  const f = psdExportFixture();
  try {
    const page = f.chapter.pages[0];
    expect(() => assertMcpPsdBudget(page)).not.toThrow();
    for (const patch of [
      { width: 0 },
      { height: 0 },
      { width: 1.5 },
      { width: NaN },
      { width: 30001 },
      { height: 30001 },
      { blocks: Array.from({ length: 201 }, () => page.blocks[0]) },
      { width: 8000, height: 8000 },
    ])
      expect(() => assertMcpPsdBudget({ ...page, ...patch })).toThrow();
    const exact = {
      ...page,
      blocks: [],
      inpaintedImagePath: undefined,
      width: 8192,
      height: 4096,
    };
    expect(() => assertMcpPsdBudget(exact)).not.toThrow();
    expect(() => assertMcpPsdBudget({ ...exact, height: 4097 })).toThrow();
    expect(f.capture.session.renderPage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
