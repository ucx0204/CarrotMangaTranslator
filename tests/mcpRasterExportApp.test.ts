import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import type {
  McpRasterExportOptions,
  McpPageExportOptions,
} from "../src/shared/mcpOutputFormats";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";

const cases: Array<McpRasterExportOptions | undefined> = [
  undefined,
  { format: "png", omitText: false },
  { format: "jpeg", omitText: false, quality: 85 },
  { format: "webp", omitText: true, quality: 92 },
];

it.each(cases)(
  "preserves saved data while the native export adapter carries options %j",
  async (imageExport) => {
    const f = await typographyAnalysisAppFixture();
    const { McpArtifactStore } =
      await import("../src/main/mcp/mcpArtifactStore");
    const { McpOperationService } =
      await import("../src/main/application/mcpOperationService");
    const { McpPageExportService } =
      await import("../src/main/application/mcpPageExportService");
    const { createMcpExportBatchAdapter } =
      await import("../src/main/mcp/mcpExportBatchAdapter");
    const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
    const artifacts = new McpArtifactStore("https://raster.fixture");
    const operations = new McpOperationService(vi.fn());
    try {
      const setup = await f.library.openChapter("chapter");
      const background = join(dirname(setup.pages[0].imagePath), "cleaned.png");
      await writeFile(background, f.bytes);
      await f.library.setPageInpaintingResult("chapter", "page", background);
      const before = await readFile(f.chapterPath);
      const render = vi.fn(async () => f.bytes);
      // Only raster encoding is a test boundary. Ownership, preflight and storage are native.
      const imageRender = vi.fn(
        async (
          _page: (typeof setup.pages)[number],
          _signal: AbortSignal,
          _options: McpPageExportOptions,
        ) => Buffer.from("encoded test raster"),
      );
      const adapter = createMcpExportBatchAdapter({
        app: f.app,
        operations,
        artifacts,
        allowImages: true,
        reportError: vi.fn(),
        exporter: new McpPageExportService({
          openChapter: f.library.openChapter,
          render,
          store: artifacts.put.bind(artifacts),
          image: {
            render: imageRender,
            store: artifacts.putImage.bind(artifacts),
          },
          assertImageAccess: async () => {},
        }),
      });
      const tool = adapter.tools.find(
        (item) => item.name === "carrot_preflight_pages_export",
      );
      if (!tool) throw new Error("Missing native preflight tool");
      const response = mcpToolResult(
        tool,
        await tool.invoke({
          chapterId: "chapter",
          pageIds: ["page"],
          ...(imageExport ? { imageExport } : {}),
        }),
      );
      expect(response.isError).toBe(false);
      const plan = response.structuredContent as {
        snapshot: string;
        pages: Array<{ pageId: string; revision: string }>;
        imageExport?: McpRasterExportOptions;
      };
      expect(plan.imageExport).toEqual(imageExport);
      const guard = vi.fn();
      const result = await adapter.exportPage(
        {
          chapterId: "chapter",
          ...plan.pages[0],
          requestId: randomUUID(),
          ...(imageExport ? { imageExport } : {}),
        },
        {
          id: randomUUID(),
          signal: new AbortController().signal,
          assertAuthorized: guard,
          progress: vi.fn(),
        },
      );
      expect(result.mimeType).toBe(`image/${imageExport?.format ?? "png"}`);
      if (imageExport) {
        expect(imageRender).toHaveBeenCalledOnce();
        expect(imageRender.mock.calls[0][2]).toEqual(imageExport);
        expect(render).not.toHaveBeenCalled();
      } else expect(render).toHaveBeenCalledOnce();
      expect(f.handoffPages).toEqual(["page"]);
      expect(f.app.jobs.all).toEqual([]);
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(await readFile(setup.pages[0].imagePath)).toEqual(f.bytes);
      expect(
        await artifacts.read(new URL(result.url).pathname.split("/")[2]),
      ).toEqual(imageExport ? Buffer.from("encoded test raster") : f.bytes);
      expect(guard).toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
    } finally {
      await operations.close();
      await artifacts.close();
      await f.close();
    }
  },
);
