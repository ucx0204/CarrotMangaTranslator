import { createMangaDomainGateway } from "./mangaGateway";
export const mcpGateway = createMangaDomainGateway("AI connection / MCP", [
  "reportMcpEditorState",
  "onMcpPageChanged",
  "onMcpEditorProbe",
  "getMcpStatus",
  "setMcpEnabled",
  "configureMcp",
  "beginMcpPairing",
  "resolveMcpPairing",
  "revokeMcpConnection",
  "diagnoseMcp",
  "openMcpHelp",
  "copyMcpUrl",
] as const);
