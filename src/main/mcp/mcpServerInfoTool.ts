import type { McpTool } from "./mcpReadTools";
import { textContent } from "./mcpReadTools";
import { allowArguments } from "./mcpArguments";
import { MCP_MODERN_VERSION, MCP_SERVER_INFO } from "./mcpProtocolEnvelope";

type Info = {
  serverId: string;
  dataProfileId: string;
  runtimeId: string;
  startedAt: number;
  appVersion: string;
  resource: string;
  mode: "development" | "installed";
};

/** Fingerprints distinguish a server restart from a different worktree; no local path or token is disclosed. */
export function createMcpServerInfoTool(info: Info): McpTool {
  const snapshot = {
    ...info,
    serverVersion: MCP_SERVER_INFO.version,
    protocolVersion: MCP_MODERN_VERSION,
    authorizationStorage: "os-encrypted-app-data-root",
    dataScope: "current-app-library",
    autoTransferAuthorization: false,
  };
  return {
    name: "carrot_get_server_info",
    requiredScopes: ["carrot.read"],
    description:
      "Identify the running app, persistent authorization authority and data profile. Compare IDs to distinguish a restart from a new worktree. No credentials or filesystem paths are returned.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    invoke: async (args) => {
      allowArguments(args, []);
      return textContent(snapshot);
    },
  };
}
