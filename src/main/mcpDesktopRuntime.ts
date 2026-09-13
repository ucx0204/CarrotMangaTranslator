import type { InpaintingJobContext } from "./jobs/inpaintingJobTypes";
import { createMcpPageOperationSession } from "./mcp/mcpPageOperationSession";
import type { McpPreferences } from "../shared/mcpDesktopTypes";
import {
  McpDesktopService,
  type McpDesktopLease,
} from "./application/mcpDesktopService";
import { McpEditorGuard } from "./application/mcpEditorGuard";
import { McpEditError } from "./application/mcpEditPolicy";
import { McpSecureStore } from "./mcp/mcpSecureStore";
import { McpDesktopAuthorization } from "./mcp/mcpDesktopAuthorization";
import { startMcpHttpServer } from "./mcp/mcpHttpServer";
import { createMcpAppTools } from "./mcp/mcpAppTools";
import {
  prepareTailscale,
  openTailscale,
  McpTailscaleSetupError,
} from "./mcp/mcpTailscale";
import { diagnoseMcpEndpoint } from "./mcp/mcpDiagnostics";

type EditingPorts = {
  processing: () => InpaintingJobContext;
  requestProbe: (id: number) => void;
  isBusy: () => boolean;
  notifySaved: (chapterId: string, pageId: string) => void;
};
export function createMcpDesktopRuntime(
  dataRoot: string,
  reportError: (error: unknown) => void,
  editing: EditingPorts,
) {
  const store = new McpSecureStore(dataRoot);
  const authorization = new McpDesktopAuthorization(store);
  const guard = new McpEditorGuard(editing.isBusy, editing.requestProbe);
  return new McpDesktopService({
    reportEditorState: (state) => guard.report(state),
    preferences: () => store.preferences(),
    savePreferences: (value) => store.savePreferences(value),
    savedStatus: () => authorization.status(),
    revokeSaved: (id) => authorization.revoke(id),
    open: (preferences, signal, failed) =>
      openDesktop({
        authorization,
        guard,
        editing,
        reportError,
        preferences,
        signal,
        failed,
      }),
    diagnose: diagnoseMcpEndpoint,
    reportError,
    setupUrl: (error) =>
      error instanceof McpTailscaleSetupError ? error.setupUrl : null,
  });
}
type DesktopOptions = {
  authorization: McpDesktopAuthorization;
  guard: McpEditorGuard;
  editing: EditingPorts;
  reportError: (error: unknown) => void;
  preferences: McpPreferences;
  signal: AbortSignal;
  failed: () => void;
};
async function openDesktop(options: DesktopOptions): Promise<McpDesktopLease> {
  const { preferences, signal, failed } = options;
  const target = await prepareTailscale();
  signal.throwIfAborted();
  const auth = await options.authorization.open(target.origin, preferences);
  const scope = new AbortController();
  const { server, pageOperations } = await openPageServer(
    options,
    auth,
    target.origin,
    scope,
  );
  const stopAccepting = () => {
    scope.abort();
    pageOperations.stop();
    server.stopAccepting();
  };
  try {
    const tunnel = await openTailscale(target, 38475, signal, () => {
      stopAccepting();
      failed();
    });
    return {
      url: `${target.origin}/mcp`,
      stopAccepting,
      close: () => closeOwnedConnection(server, tunnel, pageOperations),
      connections: () => auth.provider.connections(),
      pairingStatus: () => auth.pairing.status(),
      beginPairing: () => auth.pairing.open(),
      resolvePairing: (id, approve) => auth.pairing.resolve(id, approve),
      revoke: (id) =>
        auth.session.run(() => auth.provider.revokeConnection(id)),
    };
  } catch (error) {
    try {
      pageOperations.stop();
      await pageOperations.close();
      await server.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "MCP startup and cleanup failed.",
        { cause: cleanup },
      );
    }
    throw error;
  }
}
/** Keep the stopped listener bound until the owned public route is gone.
 * If tunnel shutdown fails, another local service must not inherit the public port. */
async function closeOwnedConnection(
  server: { close: () => Promise<void> },
  tunnel: { close: () => Promise<void> },
  pageOperations: { close: () => Promise<void> },
): Promise<void> {
  await tunnel.close();
  try {
    await pageOperations.close();
  } finally {
    await server.close();
  }
}

async function openPageServer(
  options: DesktopOptions,
  auth: Awaited<ReturnType<McpDesktopAuthorization["open"]>>,
  origin: string,
  scope: AbortController,
) {
  const editor = {
    notifySaved: options.editing.notifySaved,
    assertClean: (chapterId: string, pageId: string) =>
      options.guard.assertClean(chapterId, pageId),
    assertWritable: async (chapterId: string, pageId: string) => {
      if (scope.signal.aborted)
        throw new McpEditError(
          "editor_busy",
          "MCP is stopping. Retry after the user turns it on.",
        );
      await options.guard.assertWritable(chapterId, pageId);
      scope.signal.throwIfAborted();
    },
  };
  const pageOperations = createMcpPageOperationSession({
    origin,
    preferences: options.preferences,
    app: options.editing.processing(),
    editing: editor,
    reportError: options.reportError,
  });
  try {
    const server = await startMcpHttpServer({
      config: { port: 38475, token: auth.localToken, publicOrigin: origin },
      tools: createMcpAppTools({
        ...editor,
        preferences: options.preferences,
        additionalTools: pageOperations.tools,
      }),
      reportError: options.reportError,
      enforceScopes: true,
      oauthHttp: auth.http,
      artifacts: pageOperations.artifacts,
    });
    return { server, pageOperations };
  } catch (error) {
    try {
      await pageOperations.close();
      await auth.http.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "MCP listener startup cleanup failed.",
        { cause: cleanup },
      );
    }
    throw error;
  }
}
