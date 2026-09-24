import { createMangaDomainGateway } from "./mangaGateway";
export const mcpGateway = createMangaDomainGateway("AI connection / MCP", [
  "reportMcpEditorState",
  "onMcpPageChanged",
  "onMcpLibraryChanged",
  "onMcpEditorProbe",
  "getMcpStatus",
  "setMcpEnabled",
  "configureMcp",
  "resolveMcpPairing",
  "revokeMcpConnection",
  "diagnoseMcp",
  "openMcpHelp",
  "copyMcpUrl",
] as const);
