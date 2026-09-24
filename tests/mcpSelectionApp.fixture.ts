import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { nativePng } from "./mcpNativePng.fixture";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import {
  McpSelectionOcrSchema,
  McpSelectionTranslationSchema,
  mcpSelectionAnalysisOutputs,
} from "../src/shared/mcpSelectionAnalysis";
import type { createMcpSelectionAnalysisSession } from "../src/main/mcp/mcpSelectionAnalysisSession";

type Runtime = NonNullable<
  Parameters<typeof createMcpSelectionAnalysisSession>[3]
>;
export async function selectionAppFixture(enableEditing = false) {
  const f = await typographyAnalysisAppFixture({
    createFromBuffer: nativePng,
    createFromPath: () => ({ getSize: () => ({ width: 100, height: 100 }) }),
  });
  const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
  for (const page of stored.pages)
    for (const block of page.blocks) block.bboxSpace = "pixels";
  await writeFile(f.chapterPath, JSON.stringify(stored));
  const { getAppSettings } = await import("../src/main/settingsStore");
  const { withExecutionSettings } =
    await import("../src/main/settings/executionSettings");
  const settings = await getAppSettings(f.app.appPaths);
  settings.modelProvider = "openai-api";
  settings.api = {
    ...settings.api,
    baseUrl: "https://translation.example.test/v1",
    model: "isolated-fixture",
    apiKey: "fixture-key",
    extraBodyJson: "",
    customHeadersJson: "{}",
  };
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { createMcpSelectionAnalysisSession } =
    await import("../src/main/mcp/mcpSelectionAnalysisSession");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const { readMcpBlockTranslationContext } =
    await import("../src/main/mcp/mcpBlockTranslationContext");
  const { loadRuntimeModuleFromDirectory } =
    await import("../src/main/runtimeModuleLoader");
  const errors: unknown[] = [];
  let journal: unknown = null;
  const persistence = {
    load: async () => structuredClone(journal),
    save: async (value: unknown) => {
      journal = structuredClone(value);
    },
  };
  const operations = new McpOperationService(
    (error) => errors.push(error),
    Date.now,
    persistence,
  );
  const collect = vi.fn<NonNullable<Runtime["ocr"]>["collect"]>(
    async (options) => ({
      hints: [
        {
          x1: 0,
          y1: 0,
          x2: Math.min(10, options.imageWidth ?? 10),
          y2: Math.min(10, options.imageHeight ?? 10),
          ocrText: "再読\n한글 🥕",
        },
      ],
      diagnostics: [],
    }),
  );
  const release = vi.fn(async () => true);
  const dispose = vi.fn(async () => {});
  const request = vi.fn<NonNullable<Runtime["translation"]>["request"]>(
    async ({ userPrompt }) => {
      const input = JSON.parse(userPrompt);
      return JSON.stringify({
        blockId: input.blockId,
        translatedText: `translated ${input.sourceText}`,
      });
    },
  );
  const start = vi.fn<NonNullable<Runtime["translation"]>["start"]>(
    async () => ({
      handle: {
        provider: "openai-api",
        child: null,
        startedByScript: false,
        baseUrl: settings.api.baseUrl,
      },
      dispose,
    }),
  );
  const runtime: Runtime = {
    ocr: { collect, release },
    translation: {
      start,
      request,
      readContext: (input, options) =>
        readMcpBlockTranslationContext(input, options, (id) =>
          loadRuntimeModuleFromDirectory(
            join(process.cwd(), "src/main/runtime"),
            id,
          ),
        ),
    },
  };
  const editing = {
    assertWritable: vi.fn(async () => {}),
    notifySaved: vi.fn(),
  };
  const session = createMcpSelectionAnalysisSession(
    f.app,
    operations,
    true,
    runtime,
    enableEditing ? editing : undefined,
  );
  const tools = [...session.tools, ...createMcpOperationTools(operations, {})];
  const owner = "selection-owner";
  const auth = (principalId = owner) => ({
    principalId,
    assertAuthorized: vi.fn(),
    assertScopes: vi.fn(),
    assertJobAuthorized: vi.fn(),
  });
  const invoke = async (name: string, args: object, principal = owner) => {
    const tool = tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing selection tool ${name}`);
    return withExecutionSettings(settings, async () => {
      const output = mcpToolResult(
        tool,
        await tool.invoke(args as Record<string, unknown>, auth(principal)),
      );
      if (output.isError)
        throw new Error(JSON.stringify(output.structuredContent));
      return output.structuredContent as Record<string, unknown>;
    });
  };
  const input = async () => {
    const saved = await f.library.readWorkContextForEdit("chapter");
    return {
      chapterId: "chapter",
      contextRevision: mcpContextRevision(saved),
      requestId: randomUUID(),
      pages: saved.chapter.pages.map((page) => ({
        pageId: page.id,
        revision: createPageRevision(page),
        blockIds: [page.blocks[0].id],
      })),
    };
  };
  const ocrInput = async () => {
    const base = await input();
    return McpSelectionOcrSchema.parse({
      ...base,
      allowAssetDownloads: true,
      pages: base.pages.map(({ blockIds, ...page }) => ({
        ...page,
        targets: [
          { kind: "block", blockId: blockIds[0] },
          {
            kind: "region",
            regionId: "missing-text",
            sourceRect: { x: 10.25, y: 20.25, w: 15.5, h: 15.5 },
          },
        ],
      })),
    });
  };
  const translationInput = async () =>
    McpSelectionTranslationSchema.parse({
      ...(await input()),
      expectedEngine: "openai-api",
      allowExternal: true,
      preserveExistingTranslations: false,
    });
  const settle = async (id: string, principal = owner) => {
    await vi.waitFor(
      () => {
        if (operations.status(id, principal).status === "running")
          throw new Error("Still running");
      },
      { timeout: 10000 },
    );
    return operations.status(id, principal);
  };
  const run = async (name: string, args: object) => {
    const receipt = await invoke(name, args);
    const job = await settle(String(receipt.jobId));
    return { receipt, job };
  };
  const get = async (id: string, offset = 0, limit = 10) =>
    mcpSelectionAnalysisOutputs.carrot_get_selection_analysis.parse(
      await invoke("carrot_get_selection_analysis", {
        analysisId: id,
        offset,
        limit,
      }),
    );
  return {
    ...f,
    settings,
    withExecutionSettings,
    operations,
    persistence,
    session,
    editing,
    runtime,
    tools,
    owner,
    auth,
    invoke,
    input,
    ocrInput,
    translationInput,
    settle,
    run,
    get,
    collect,
    release,
    start,
    request,
    dispose,
    errors,
    close: async () => {
      session.stop();
      operations.stop();
      await operations.close();
      await session.close();
      await f.close();
    },
  };
}
