import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { contextMigrationAppFixture } from "./mcpContextMigrationApp.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { McpContextExportReviewSchema } from "../src/shared/mcpContextExchange";
import { McpWorkFileExportReviewSchema } from "../src/shared/mcpWorkFileExport";
import {
  mcpJobFileOutput,
  mcpJobReceiptOutput,
} from "../src/main/mcp/mcpJobOutputSchema";
import { mcpRetentionOutputs } from "../src/shared/mcpRetention";
import {
  McpOutputDeliveryReportSchema,
  type McpOutputDeliveryTarget,
} from "../src/shared/mcpOutputDelivery";
import type { McpTool } from "../src/main/mcp/mcpReadTools";

type Caller = NonNullable<Parameters<McpTool["invoke"]>[1]>;
const integrationToken = (url: string) => new URL(url).pathname.split("/")[2];

/** Real composition shares one import upload store and the retained migration.
 * Only PNG renderer bytes are supplied; native context and work-file writers run. */
export async function exchangeToolIntegrationFixture(
  options: { images?: boolean; editing?: boolean } = {},
) {
  const f = await contextMigrationAppFixture();
  await f.current().session.close();
  // Persist this native default so repeated read-only graphs compare saved timestamps.
  await f.library.saveChapterStoryMemory(
    await f.library.getChapterStoryMemory("chapter"),
  );
  // The inherited fixture resets modules; use the same error class as the new native sessions.
  const { McpEditError } =
    await import("../src/main/application/mcpEditPolicy");
  const { McpOperationService } =
    await import("../src/main/application/mcpOperationService");
  const { McpArtifactStore } = await import("../src/main/mcp/mcpArtifactStore");
  const { McpOutputDeliveryObserver } =
    await import("../src/main/mcp/mcpOutputDeliveryObserver");
  const { createMcpRetentionSession } =
    await import("../src/main/mcp/mcpRetentionSession");
  const { createRetainedOutputPublisher, bindRetainedOutputSource } =
    await import("../src/main/mcp/mcpRetainedOutputs");
  const { createMcpAuxiliarySessions } =
    await import("../src/main/mcp/mcpAuxiliarySessions");
  const { createMcpOperationTools } =
    await import("../src/main/mcp/mcpOperationTools");
  const { createMcpJobFileTool } =
    await import("../src/main/mcp/mcpJobFileTool");
  const { createMcpOutputDeliveryAdapter } =
    await import("../src/main/mcp/mcpOutputDeliveryAdapter");
  const { createMcpWorkFileExportAdapter } =
    await import("../src/main/mcp/mcpWorkFileExportAdapter");
  const { McpPageExportService } =
    await import("../src/main/application/mcpPageExportService");
  const { mcpJobTargetSchema } =
    await import("../src/main/application/mcpJobJournal");
  const { readImageRedactionState, setImageRedactionEnabled } =
    await import("../src/main/imageRedactionStore");
  const owner = "exchange-integration-owner";
  const errors: unknown[] = [];
  const rendered = Buffer.from("PNG renderer boundary for job-file glue");
  const render = vi.fn(async () => rendered);
  const preferences = {
    autoStart: false,
    allowImages: options.images ?? false,
    allowEditing: options.editing ?? false,
    allowProcessing: options.editing ?? false,
  };
  const open = async () => {
    const operations = new McpOperationService((error) => errors.push(error));
    const observer = new McpOutputDeliveryObserver();
    const artifacts = new McpArtifactStore(
      "http://127.0.0.1:38588",
      Date.now,
      createRetainedOutputPublisher(f.storage),
      observer,
    );
    const retained = createMcpRetentionSession(
      f.storage,
      artifacts,
      f.app,
      f.editing,
      preferences.allowEditing,
      preferences.allowImages,
    );
    const auxiliary = createMcpAuxiliarySessions(
      {
        app: f.app,
        editing: f.editing,
        preferences,
        origin: "http://127.0.0.1:38588",
        reportError: (error) => errors.push(error),
      },
      { operations, artifacts, retained, storage: f.storage },
    );
    const exporter = new McpPageExportService({
      openChapter: f.library.openChapter,
      render,
      store: artifacts.put.bind(artifacts),
      bindSource: bindRetainedOutputSource,
      assertImageAccess: async () => {
        if ((await readImageRedactionState()).enabled)
          throw new McpEditError(
            "access_denied",
            "Native redaction is enabled",
          );
      },
    });
    const tools = [
      ...auxiliary.tools,
      ...retained.tools,
      ...createMcpWorkFileExportAdapter({
        app: f.app,
        operations,
        artifacts,
        allowImages: preferences.allowImages,
      }).tools,
      ...createMcpOperationTools(
        operations,
        {
          exportPng: preferences.allowImages
            ? (target, job) =>
                exporter.export(mcpJobTargetSchema.parse(target), job)
            : undefined,
        },
        artifacts.assertAvailable.bind(artifacts),
        {
          allowImages: preferences.allowImages,
          disclosed: artifacts.disclosed.bind(artifacts),
        },
      ),
      ...createMcpOutputDeliveryAdapter({
        operations,
        artifacts,
        observer,
        catalog: retained.catalog,
        allowImages: preferences.allowImages,
      }),
    ].map((tool) => retained.wrap(tool));
    await operations.ready();
    await retained.ready();
    return {
      operations,
      observer,
      artifacts,
      retained,
      auxiliary,
      tools,
      close: async () => {
        auxiliary.stop();
        operations.stop();
        await auxiliary.close();
        await operations.close();
        await retained.close();
        await artifacts.close();
      },
    };
  };
  let current = await open();
  const caller = (scopes = ["carrot.read"], principalId = owner): Caller => {
    const check = (required: readonly string[] = []) => {
      if (required.some((scope) => !scopes.includes(scope)))
        throw new McpEditError(
          "access_denied",
          "Connection lacks required scopes",
        );
    };
    return {
      principalId,
      assertAuthorized: () => {},
      assertScopes: check,
      assertJobAuthorized: check,
    };
  };
  const all = () =>
    caller(["carrot.read", "carrot.images", "carrot.edit", "carrot.process"]);
  const call = async (
    name: string,
    input: Record<string, unknown>,
    auth = caller(),
  ) => {
    const tool = current.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing native exchange tool ${name}`);
    const content = await tool.invoke(input, auth);
    const text = content.find((item) => item.type === "text");
    if (!text || text.type !== "text")
      throw new Error("Expected JSON tool response");
    return { content, value: JSON.parse(text.text) as unknown };
  };
  const done = (jobId: string) =>
    current.operations.waitForCompletion(
      jobId,
      owner,
      new AbortController().signal,
    );
  const startContext = async () => {
    const target = {
      workId: "work",
      chapterId: "chapter",
      scope: "guide-and-memory",
    };
    const review = McpContextExportReviewSchema.parse(
      (await call("carrot_preflight_context_export", target)).value,
    );
    const input = {
      ...target,
      sourceSnapshot: review.sourceSnapshot,
      requestId: randomUUID(),
    };
    const started = mcpJobReceiptOutput.parse(
      (await call("carrot_export_context_json", input)).value,
    );
    return { review, input, started, settled: await done(started.jobId) };
  };
  const jobFile = async (
    jobId: string,
    includeAttachment = false,
    auth = caller(),
  ) => {
    const response = await call(
      "carrot_get_job_file",
      { jobId, ...(includeAttachment ? { includeAttachment: true } : {}) },
      auth,
    );
    return { ...response, file: mcpJobFileOutput.parse(response.value) };
  };
  return {
    ...f,
    owner,
    errors,
    render,
    rendered,
    caller,
    all,
    call,
    done,
    startContext,
    jobFile,
    resources: () => current,
    read: (url: string) => current.artifacts.read(integrationToken(url)),
    issue: async (id: string) =>
      mcpRetentionOutputs.carrot_get_output_file.parse(
        (await call("carrot_get_output_file", { id })).value,
      ),
    report: async (target: McpOutputDeliveryTarget, auth = caller()) =>
      McpOutputDeliveryReportSchema.parse(
        (await call("carrot_get_output_delivery", { target }, auth)).value,
      ),
    startPng: async () => {
      const page = (await f.library.openChapter("chapter")).pages[0];
      const started = mcpJobReceiptOutput.parse(
        (
          await call(
            "carrot_export_page_png",
            {
              chapterId: "chapter",
              pageId: page.id,
              revision: createPageRevision(page),
              requestId: randomUUID(),
            },
            all(),
          )
        ).value,
      );
      return { started, settled: await done(started.jobId) };
    },
    startWorkFile: async () => {
      const review = McpWorkFileExportReviewSchema.parse(
        (
          await call("carrot_preflight_work_file_export", {
            workId: "work",
            chapterIds: ["chapter"],
          })
        ).value,
      );
      const started = mcpJobReceiptOutput.parse(
        (
          await call(
            "carrot_export_work_file",
            {
              workId: review.workId,
              chapterIds: review.chapterIds,
              snapshot: review.snapshot,
              sourceSnapshot: review.sourceSnapshot,
              requestId: randomUUID(),
              acknowledgeOriginalImages: true,
              acknowledgeV1Limitations: true,
            },
            all(),
          )
        ).value,
      );
      return { started, settled: await done(started.jobId) };
    },
    jobFileWithImagesDisabled: (jobId: string) =>
      createMcpJobFileTool(current.operations, {
        allowImages: false,
        available: current.artifacts.assertAvailable.bind(current.artifacts),
        disclosed: current.artifacts.disclosed.bind(current.artifacts),
      }).invoke({ jobId }, all()),
    redaction: (enabled: boolean) =>
      setImageRedactionEnabled(enabled, f.env.root),
    restart: async () => {
      await current.close();
      current = await open();
    },
    close: async () => {
      await current.close();
      await f.close();
    },
  };
}
