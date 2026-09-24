import { expect, it } from "vitest";
import { exportFixture } from "./mcpExportBatch.fixture";
import { sourceExportFixture, sourcePolicy } from "./mcpSourceExport.fixture";
import { mcpExportSnapshot } from "../src/main/application/mcpExportSelection";
import { mcpOperationFile } from "../src/main/application/mcpOperationOutputs";

it.each([undefined, []])(
  "rejects a source snapshot without selected native evidence (%s)",
  async (sourcePages) => {
    const f = exportFixture();
    const before = structuredClone(f.chapter);
    try {
      expect(() =>
        mcpExportSnapshot(f.chapter, sourcePolicy, sourcePages),
      ).toThrow("Source-format review evidence is required.");
      expect(mcpExportSnapshot(f.chapter)).toMatch(/^[a-f0-9]{16}$/);
      expect(f.chapter).toEqual(before);
      expect(f.render).not.toHaveBeenCalled();
      expect(f.renderImage).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("refuses source preflight when native naming evidence is unavailable while preserving ordinary PNG export", async () => {
  const f = exportFixture();
  const before = structuredClone(f.chapter);
  try {
    await expect(
      f.service.preflight(
        { chapterId: f.chapter.id, imageExport: sourcePolicy },
        f.assertRetained,
      ),
    ).rejects.toMatchObject({
      code: "invalid_edit",
      message: "Native source-format evidence is unavailable.",
    });
    const ordinary = await f.service.preflight(
      { chapterId: f.chapter.id },
      f.assertRetained,
    );
    expect(ordinary.pages.every((page) => page.filename.endsWith(".png"))).toBe(
      true,
    );
    expect(f.chapter).toEqual(before);
    expect(f.render).not.toHaveBeenCalled();
    expect(f.renderImage).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["imageExport", "sourceFormatBasis", "fallback"] as const)(
  "refuses a source-policy file receipt missing %s without invalidating the existing artifact",
  async (field) => {
    const f = sourceExportFixture();
    try {
      const result = await f.run(["p2"]);
      expect(result.status).toBe("completed");
      const originalPage = result.exportPages.pages[0];
      const bytes = await f.file(originalPage);
      const corrupted = structuredClone(result);
      delete corrupted.exportPages.pages[0][field];
      expect(() =>
        mcpOperationFile(
          {
            settled: true,
            status: "completed",
            kind: "exportPages",
            result: corrupted,
          },
          "p2",
        ),
      ).toThrow("Completed output is unavailable.");
      const restored = mcpOperationFile(
        {
          settled: true,
          status: "completed",
          kind: "exportPages",
          result,
        },
        "p2",
      );
      expect(restored.mimeType).toBe("image/jpeg");
      expect(restored.imageExport).toEqual({
        format: "jpeg",
        omitText: false,
        quality: 85,
      });
      expect((await f.file(originalPage)).equals(bytes)).toBe(true);
      expect(f.renderImage).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  },
);
