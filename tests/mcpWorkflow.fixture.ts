import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { selectionAppFixture } from "./mcpSelectionApp.fixture";
import { mcpTestEncryption } from "./mcpEncryption.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpWorkflowOutputs, type McpWorkflowStage } from "../src/shared/mcpWorkflow";

/** Native jobs, tools, page saves, context, retention, encryption and ZIP are real.
 * Only external text-model/renderer/Electron boundaries are deterministic fixtures. */
export async function workflowFixture() {
  const f = await selectionAppFixture(true);
  const { McpSecureStore } = await import("../src/main/mcp/mcpSecureStore");
  const { McpRetentionStorage } = await import("../src/main/mcp/mcpRetentionStorage");
  const { McpArtifactStore } = await import("../src/main/mcp/mcpArtifactStore");
  const { createRetainedOutputPublisher, bindRetainedOutputSource } = await import("../src/main/mcp/mcpRetainedOutputs");
  const { wrapRetainedTool } = await import("../src/main/mcp/mcpRecoveryCapture");
  const { McpOperationService } = await import("../src/main/application/mcpOperationService");
  const { McpPageExportService } = await import("../src/main/application/mcpPageExportService");
  const { createMcpOperationTools } = await import("../src/main/mcp/mcpOperationTools");
  const { createMcpSelectionAnalysisSession } = await import("../src/main/mcp/mcpSelectionAnalysisSession");
  const { createMcpWorkflowSession } = await import("../src/main/mcp/mcpWorkflowSession");
  const { createMcpAppTools } = await import("../src/main/mcp/mcpAppTools");
  const { createMcpPageEditScope } = await import("../src/main/mcp/mcpPageEditScope");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const { runMcpAppJob } = await import("../src/main/mcp/mcpAppJob");
  const encryption = mcpTestEncryption();
  const codec = new McpSecureStore(f.env.root, encryption).retentionCodec();
  const storage = new McpRetentionStorage(codec);
  const errors: unknown[] = [];
  const reportError = (error: unknown) => { errors.push(error); };
  const render = vi.fn(async (page: { imagePath: string }) => readFile(page.imagePath));
  const preferences = { allowEditing: true, allowProcessing: true, allowImages: true, autoStart: false };
  let journal: unknown = null;
  const open = async () => {
    const operations = new McpOperationService(reportError, Date.now, {
      load: async () => structuredClone(journal),
      save: async (value) => { journal = structuredClone(value); },
    });
    await operations.ready();
    const selection = createMcpSelectionAnalysisSession(f.app, operations, true, f.runtime, f.editing);
    const artifacts = new McpArtifactStore("https://workflow.test", Date.now, createRetainedOutputPublisher(storage));
    const exporter = new McpPageExportService({
      openChapter: f.library.openChapter, render: (page) => render(page),
      store: artifacts.put.bind(artifacts), bindSource: bindRetainedOutputSource,
      assertImageAccess: async () => {},
    });
    const wrap = (tool: Parameters<typeof wrapRetainedTool>[1]) => wrapRetainedTool(storage, tool);
    const native = [
      ...selection.tools,
      ...createMcpOperationTools(operations, {
        exportPng: (target, context) => runMcpAppJob(f.app, context, "page-export", (job) => exporter.export(target, job), {
          resources: [], page: { ...target, readChapter: f.library.openChapter },
        }),
      }),
    ].map(wrap);
    const workflow = createMcpWorkflowSession({
      app: f.app, operations, storage, preferences, tools: native,
      waitSelection: selection.waitForEdit, reportError,
    });
    const lifetime = new AbortController();
    const tools = createMcpAppTools({
      ...f.editing, assertClean: f.editing.assertWritable, preferences,
      additionalTools: [...workflow.tools, ...native], lifetime: lifetime.signal,
      withPageEdit: createMcpPageEditScope(f.app, f.library.openChapter, lifetime.signal),
      wrapTool: wrap,
    });
    return { operations, selection, artifacts, workflow, tools, lifetime };
  };
  let current = await open();
  const invoke = async (name: string, args: object, caller = f.auth()) => f.withExecutionSettings(f.settings, async () => {
    const tool = current.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing workflow fixture tool: ${name}`);
    return mcpToolResult(tool, await tool.invoke(args as Record<string, unknown>, caller)).structuredContent;
  });
  const get = async (id: string) => mcpWorkflowOutputs.carrot_get_workflow.parse(await invoke("carrot_get_workflow", { id }));
  const prepare = async (stages: McpWorkflowStage[] = [{
    kind: "translate", expectedEngine: "openai-api", allowExternal: true, allowAssetDownloads: false,
    preserveExistingTranslations: false, contextMode: "saved",
  }, { kind: "export-png" }], extra: object = {}) => {
    const chapter = await f.library.openChapter("chapter");
    return mcpWorkflowOutputs.carrot_prepare_workflow.parse(await invoke("carrot_prepare_workflow", {
      requestId: randomUUID(), reason: "Isolated ordered workflow",
      chapters: [{ chapterId: chapter.id, pages: [...chapter.pages].reverse().map((page) => ({ pageId: page.id, revision: createPageRevision(page) })) }],
      stages, ...extra,
    }));
  };
  const run = async (id: string, retryFailed = false, requestId = randomUUID()) => {
    const view = await get(id);
    const input = { id, version: view.version, requestId, retryFailed };
    const receipt = mcpWorkflowOutputs.carrot_run_workflow.parse(await invoke("carrot_run_workflow", input));
    return { input, receipt };
  };
  const done = async (id: string) => {
    await vi.waitFor(async () => { if ((await get(id)).status === "running") throw new Error("Workflow still running"); }, { timeout: 20000 });
    return get(id);
  };
  const closeCurrent = async () => {
    await current.workflow.close();
    current.lifetime.abort();
    current.operations.stop();
    current.selection.stop();
    await current.operations.close();
    await current.selection.close();
    await current.artifacts.close();
  };
  return {
    ...f, storage, codec, encryption, errors, render, invoke, get, prepare, run, done,
    current: () => current,
    restart: async () => { await closeCurrent(); current = await open(); },
    close: async () => { await closeCurrent(); await f.close(); },
  };
}
