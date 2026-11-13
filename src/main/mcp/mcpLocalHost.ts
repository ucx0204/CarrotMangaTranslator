import { randomBytes, randomUUID } from "node:crypto";
import { app } from "electron";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { ReviewedLinkedOutputPort } from "../linkedWorkspace/linkedWorkspaceReviewedOutputTypes";
import type { McpLibraryChangedEvent } from "../../shared/mcpEditingTypes";
import { DEFAULT_MCP_PREFERENCES } from "../../shared/mcpDesktopTypes";
import { McpEditorGuard } from "../application/mcpEditorGuard";
import { createMcpPageOperationSession } from "./mcpPageOperationSession";
import { createMcpAppTools } from "./mcpAppTools";
import { createMcpPageEditScope } from "./mcpPageEditScope";
import { createMcpServerInfoTool } from "./mcpServerInfoTool";
import { startMcpHttpServer } from "./mcpHttpServer";
import type { McpSecureStore } from "./mcpSecureStore";
import type { McpTool } from "./mcpReadTools";

export type McpLocalEditing = {
  notifyLibraryChanged?: (event: McpLibraryChangedEvent) => void;
  processing: () => InpaintingJobContext;
  outputSync?: () => ReviewedLinkedOutputPort;
  requestProbe: (id: number) => void;
  isBusy: () => boolean;
  notifySaved: (chapterId: string, pageId: string) => void;
};
export type McpChatObservation = {
  name: string;
  args: Record<string, unknown>;
  content: Awaited<ReturnType<McpTool["invoke"]>>;
};
const INTERNAL_SCOPES = "carrot.read carrot.images carrot.edit carrot.process";

/** One native session and journal for public MCP and in-app conversations. */
export class McpLocalHost {
  readonly guard: McpEditorGuard;
  private starting?: Promise<Awaited<ReturnType<McpLocalHost["start"]>>>;
  private readonly lifetime = new AbortController();
  private readonly clients = new Map<
    string,
    {
      principal: string;
      clientName: string;
      observe: (result: McpChatObservation) => Promise<void>;
    }
  >();

  constructor(
    private readonly store: McpSecureStore,
    private readonly editing: McpLocalEditing,
    private readonly reportError: (error: unknown) => void,
  ) {
    this.guard = new McpEditorGuard(editing.isBusy, editing.requestProbe);
  }
  ready() {
    this.lifetime.signal.throwIfAborted();
    this.starting ??= this.start().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }
  async connect(
    principal: string,
    observe: (result: McpChatObservation) => Promise<void>,
    clientName = "Codex",
  ) {
    const host = await this.ready();
    this.lifetime.signal.throwIfAborted();
    const token = randomBytes(32).toString("base64url");
    this.clients.set(`Bearer ${token}`, { principal, observe, clientName });
    return {
      url: host.server.url,
      token,
      close: () => {
        this.clients.delete(`Bearer ${token}`);
      },
    };
  }
  async dispose() {
    this.lifetime.abort();
    this.clients.clear();
    if (!this.starting) return;
    const host = await this.starting;
    host.server.stopAccepting();
    host.pageOperations.stop();
    try {
      await host.pageOperations.close();
    } finally {
      await host.server.close();
    }
  }
  private async start() {
    const tools: McpTool[] = [];
    const identity = await this.store.identity();
    const state: {
      operations?: ReturnType<typeof createMcpPageOperationSession>;
    } = {};
    const server = await startMcpHttpServer({
      config: { port: 0, token: randomBytes(32).toString("base64url") },
      tools,
      enforceScopes: true,
      reportError: this.reportError,
      artifacts: () => state.operations?.artifacts,
      authorization: {
        scopeFor: (header) =>
          this.clients.has(header) ? INTERNAL_SCOPES : undefined,
        principalFor: (header) => this.clients.get(header)?.principal,
        clientNameFor: (header) => this.clients.get(header)?.clientName,
        scopeForPrincipal: (principal) =>
          [...this.clients.values()].some((c) => c.principal === principal)
            ? INTERNAL_SCOPES
            : undefined,
      },
    });
    const origin = new URL(server.url).origin;
    const editor = this.editor();
    try {
      const pageOperations = createMcpPageOperationSession({
        origin,
        preferences: { ...DEFAULT_MCP_PREFERENCES },
        app: this.editing.processing(),
        outputSync: this.editing.outputSync?.(),
        editing: editor,
        reportError: this.reportError,
        retentionCodec: this.store.retentionCodec(),
        jobPersistence: this.store.jobPersistence(),
      });
      state.operations = pageOperations;
      await pageOperations.ready();
      const nativeTools = createMcpAppTools({
        ...editor,
        assertWritable: editor.assertClean,
        preferences: { ...DEFAULT_MCP_PREFERENCES },
        withPageEdit: createMcpPageEditScope(
          this.editing.processing(),
          undefined,
          this.lifetime.signal,
        ),
        lifetime: this.lifetime.signal,
        wrapTool: pageOperations.wrapTool,
        bindNativeTools: pageOperations.bindNativeTools,
        readTranslationCompletion: pageOperations.readTranslationCompletion,
        additionalTools: [
          ...pageOperations.tools,
          createMcpServerInfoTool({
            ...identity,
            runtimeId: randomUUID(),
            startedAt: Date.now(),
            appVersion: app.getVersion(),
            resource: server.url,
            mode: app.isPackaged ? "installed" : "development",
          }),
        ],
      });
      tools.push(...nativeTools.map((tool) => this.observed(tool)));
      return { server, pageOperations, tools: nativeTools, origin };
    } catch (error) {
      const cleanup = await Promise.allSettled([
        state.operations?.close(),
        server.close(),
      ]);
      for (const result of cleanup)
        if (result.status === "rejected") this.reportError(result.reason);
      throw error;
    }
  }
  private observed(tool: McpTool): McpTool {
    return {
      ...tool,
      invoke: async (args, context) => {
        const content = await tool.invoke(args, context);
        const client = [...this.clients.values()].find(
          (c) => c.principal === context?.principalId,
        );
        await client?.observe({ name: tool.name, args, content });
        return content;
      },
    };
  }
  private editor() {
    return {
      assertClean: (chapterId: string, pageId: string) =>
        this.guard.assertClean(chapterId, pageId),
      assertWritable: async (chapterId: string, pageId: string) => {
        this.lifetime.signal.throwIfAborted();
        await this.guard.assertWritable(chapterId, pageId);
        this.lifetime.signal.throwIfAborted();
      },
      assertChapterClosed: (chapterId: string) =>
        this.guard.assertChapterClosed(chapterId),
      notifySaved: this.editing.notifySaved,
      notifyLibraryChanged: this.editing.notifyLibraryChanged,
    };
  }
}
