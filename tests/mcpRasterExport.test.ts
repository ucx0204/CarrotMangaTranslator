import { expect, it } from "vitest";
import { exportFixture, readExportZip } from "./mcpExportBatch.fixture";
import {
  McpRasterExportOptionsSchema,
  mcpRasterFormat,
  mcpArtifactMime,
  mcpArtifactName,
} from "../src/shared/mcpOutputFormats";
import { McpExportPagesMetadataSchema } from "../src/shared/mcpExportBatch";

it.each(["png", "jpeg", "webp"] as const)(
  "exports %s with exact metadata and packs existing bytes without rerendering",
  async (format) => {
    const f = exportFixture();
    try {
      const before = structuredClone(f.chapter);
      const options = McpRasterExportOptionsSchema.parse({
        format,
        ...(format === "png" ? {} : { quality: 87 }),
      });
      const target = await f.target(["p3", "p1"], options);
      const result = await f.service.run(target, f.context, f.assertRetained);
      const identity = mcpRasterFormat(format);
      expect(result.status).toBe("completed");
      expect(result.exportPages.pages.map((page) => page.filename)).toEqual([
        `0001.${identity.extension}`,
        `0003.${identity.extension}`,
      ]);
      expect(f.render).not.toHaveBeenCalled();
      expect(f.renderImage).toHaveBeenCalledTimes(2);
      expect(f.renderImage.mock.calls[0][2]).toEqual(options);
      const first = result.exportPages.pages[0];
      expect(first.mimeType).toBe(identity.mimeType);
      expect(await f.file(first)).toEqual(Buffer.from(`${format} fixture p1`));
      const zip = await f.zip(result);
      const archive = readExportZip(await f.read(zip.url));
      expect(archive[`0001.${identity.extension}`]).toEqual(
        await f.file(first),
      );
      const manifest = JSON.parse(archive["manifest.json"].toString());
      expect(manifest.imageExport).toEqual(options);
      expect(manifest.partialOutput).toBe(false);
      expect(JSON.stringify(manifest)).not.toContain("/mcp-artifacts/");
      expect(
        JSON.stringify(McpExportPagesMetadataSchema.parse(result.exportPages)),
      ).not.toContain("/mcp-artifacts/");
      expect(f.renderImage).toHaveBeenCalledTimes(2);
      expect(f.chapter).toEqual(before);
      expect(mcpArtifactName(identity.mimeType)).toBe(identity.name);
      expect(mcpArtifactMime(identity.name)).toBe(identity.mimeType);
    } finally {
      await f.close();
    }
  },
);

it("rejects changed format, quality or text omission under a previously reviewed target", async () => {
  const f = exportFixture();
  try {
    const target = await f.target(undefined, {
      format: "jpeg",
      quality: 80,
      omitText: false,
    });
    for (const imageExport of [
      { format: "webp" as const, quality: 80, omitText: false },
      { format: "jpeg" as const, quality: 90, omitText: false },
      { format: "jpeg" as const, quality: 80, omitText: true },
    ]) {
      await expect(
        f.service.run({ ...target, imageExport }, f.context, f.assertRetained),
      ).rejects.toMatchObject({ code: "revision_conflict" });
    }
    expect(f.renderImage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects textless output without inpainting and never starts erasure or falls back to the original", async () => {
  const f = exportFixture();
  try {
    for (const page of f.chapter.pages) delete page.inpaintedImagePath;
    const target = await f.target(undefined, { format: "png", omitText: true });
    const result = await f.service.run(target, f.context, f.assertRetained);
    expect(result.status).toBe("failed");
    expect(result.exportPages.pages.map((page) => page.status)).toEqual([
      "failed",
      "unprocessed",
      "unprocessed",
    ]);
    expect(f.renderImage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("preserves completed image bytes on later failure and requires explicit partial ZIP consent", async () => {
  const f = exportFixture();
  try {
    f.renderImage.mockImplementation(async (page) => {
      if (page.id === "p2") throw new Error("Injected renderer failure");
      return Buffer.from("first jpeg");
    });
    const result = await f.service.run(
      await f.target(undefined, {
        format: "jpeg",
        quality: 90,
        omitText: false,
      }),
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
    expect(archive["0001.jpg"]).toEqual(Buffer.from("first jpeg"));
    expect(JSON.parse(archive["manifest.json"].toString()).completed).toBe(1);
    const url = result.exportPages.pages[0].url;
    if (!url) throw new Error("Expected the completed source link");
    await expect(
      f.store.zip(
        [{ url, filename: "0001.png" }],
        {},
        async () => {},
        f.context.signal,
      ),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("requires explicit valid lossy quality and never accepts unsupported formats or option fields", () => {
  for (const input of [
    { format: "jpeg" },
    { format: "webp" },
    { format: "png", quality: 90 },
    { format: "jpeg", quality: 0 },
    { format: "webp", quality: 101 },
    { format: "jpeg", quality: 1.5 },
    { format: "psd" },
    { format: "png", outputPath: "C:/private" },
  ])
    expect(McpRasterExportOptionsSchema.safeParse(input).success).toBe(false);
  expect(mcpArtifactName("application/zip")).toBe("pages.zip");
  expect(mcpArtifactMime("pages.zip")).toBe("application/zip");
  expect(() => mcpArtifactMime("../page.png")).toThrow();
});
