import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import { McpExportPreflightOutput } from "../src/shared/mcpExportBatch";
import { createPageRevision } from "../src/shared/pageRevision";
import type { McpPageExportOptions } from "../src/shared/mcpOutputFormats";

it.each([
  ["private-original.JPEG", "jpeg", 72],
  ["private-original.WEBP", "webp", 83],
] as const)(
  "uses native saved-name preflight and page handoff for %s",
  async (name, format, quality) => {
    const f = await typographyAnalysisAppFixture();
    const { McpArtifactStore } =
      await import("../src/main/mcp/mcpArtifactStore");
    const { McpOperationService } =
      await import("../src/main/application/mcpOperationService");
    const { McpPageExportService } =
      await import("../src/main/application/mcpPageExportService");
    const { createMcpExportBatchAdapter } =
      await import("../src/main/mcp/mcpExportBatchAdapter");
    const { bindRetainedOutputSource } =
      await import("../src/main/mcp/mcpRetainedOutputs");
    const { readMcpExportSourceName } =
      await import("../src/main/mcp/mcpSourceExport");
    const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
    const artifacts = new McpArtifactStore("https://source-format.fixture");
    const operations = new McpOperationService(vi.fn());
    try {
      const saved = JSON.parse(await readFile(f.chapterPath, "utf8"));
      saved.pages[0].sourceFileName = name;
      saved.pages[0].name = "different-display-name.png";
      await writeFile(f.chapterPath, JSON.stringify(saved));
      const page = (await f.library.openChapter("chapter")).pages[0];
      const before = await readFile(f.chapterPath);
      const imageRender = vi.fn(
        async (
          _page: typeof page,
          _signal: AbortSignal,
          _options: McpPageExportOptions,
        ) => Buffer.from("external codec boundary"),
      );
      const render = vi.fn(async () => f.bytes);
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
          bindSource: bindRetainedOutputSource,
          assertImageAccess: async () => {},
        }),
      });
      const tool = adapter.tools.find(
        (item) => item.name === "carrot_preflight_pages_export",
      );
      if (!tool) throw new Error("Missing source preflight tool");
      const response = mcpToolResult(
        tool,
        await tool.invoke({
          chapterId: "chapter",
          pageIds: ["page"],
          imageExport: {
            format: "source",
            omitText: false,
            jpegQuality: 72,
            webpQuality: 83,
            unsupportedSource: "reject",
          },
        }),
      );
      expect(response.isError).toBe(false);
      const plan = McpExportPreflightOutput.parse(response.structuredContent);
      const options = plan.pages[0].imageExport;
      if (!options) throw new Error("Missing resolved source-page options");
      expect(options).toEqual({ format, omitText: false, quality });
      expect(JSON.stringify(plan)).not.toMatch(
        /private-original|different-display|sourceNameFingerprint|imagePath/,
      );
      const target = {
        chapterId: "chapter",
        pageId: page.id,
        revision: createPageRevision(page),
        requestId: randomUUID(),
        imageExport: options,
        sourceNameFingerprint:
          readMcpExportSourceName(page).sourceNameFingerprint,
      };
      const job = {
        id: randomUUID(),
        signal: new AbortController().signal,
        assertAuthorized: vi.fn(),
        progress: vi.fn(),
      };
      const output = await adapter.exportPage(target, job);
      expect(imageRender).toHaveBeenCalledOnce();
      expect(imageRender.mock.calls[0][2]).toEqual(options);
      expect(output.mimeType).toBe(`image/${format}`);
      expect(JSON.stringify(output)).not.toContain("sourceNameFingerprint");
      expect(
        await artifacts.read(new URL(output.url).pathname.split("/")[2]),
      ).toEqual(Buffer.from("external codec boundary"));
      expect(f.handoffPages).toEqual(["page"]);
      expect(f.app.jobs.all).toEqual([]);
      expect(await readFile(f.chapterPath)).toEqual(before);
      expect(await readFile(page.imagePath)).toEqual(f.bytes);
      expect(f.prepare).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();

      saved.pages[0].sourceFileName = "changed.png";
      await writeFile(f.chapterPath, JSON.stringify(saved));
      expect(
        createPageRevision((await f.library.openChapter("chapter")).pages[0]),
      ).toBe(target.revision);
      await expect(
        adapter.exportPage(
          { ...target, requestId: randomUUID() },
          {
            ...job,
            id: randomUUID(),
          },
        ),
      ).rejects.toMatchObject({ code: "revision_conflict" });
      expect(imageRender).toHaveBeenCalledOnce();
      expect(f.app.jobs.all).toEqual([]);
    } finally {
      await operations.close();
      await artifacts.close();
      await f.close();
    }
  },
);
