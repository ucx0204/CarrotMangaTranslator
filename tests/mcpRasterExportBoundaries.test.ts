import { expect, it, vi } from "vitest";
import { McpPageExportService } from "../src/main/application/mcpPageExportService";
import { mcpOperationFile } from "../src/main/application/mcpOperationOutputs";
import { exportFixture } from "./mcpExportBatch.fixture";

it("does not fall back to PNG when an explicit raster adapter is unavailable", async () => {
  const f = exportFixture();
  try {
    const store = vi.fn(f.store.put.bind(f.store));
    const exporter = new McpPageExportService({
      openChapter: f.openChapter,
      render: f.render,
      store,
      assertImageAccess: async () => f.assertRetained(),
    });
    const target = await f.target(["p1"]);
    await expect(
      exporter.exportImage(
        {
          chapterId: target.chapterId,
          ...target.pages[0],
          imageExport: { format: "jpeg", quality: 90, omitText: false },
        },
        f.context,
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.render).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["mime", "extension"])(
  "refuses a completed JPEG file whose %s contradicts the reviewed format",
  async (field) => {
    const f = exportFixture();
    try {
      const result = await f.service.run(
        await f.target(["p1"], {
          format: "jpeg",
          quality: 90,
          omitText: false,
        }),
        f.context,
        f.assertRetained,
      );
      const entry = {
        settled: true,
        status: "completed",
        kind: "exportPages",
        result,
      };
      expect(mcpOperationFile(entry, "p1")).toMatchObject({
        mimeType: "image/jpeg",
        filename: "0001.jpg",
      });
      const altered = structuredClone(entry);
      if (field === "mime")
        altered.result.exportPages.pages[0].mimeType = "image/png";
      else altered.result.exportPages.pages[0].filename = "0001.png";
      expect(() => mcpOperationFile(altered, "p1")).toThrow();
      expect(mcpOperationFile(entry, "p1")).toMatchObject({
        mimeType: "image/jpeg",
        filename: "0001.jpg",
      });
      expect(f.renderImage).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  },
);
