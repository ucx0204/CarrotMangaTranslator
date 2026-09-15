import type { McpEditorState } from "./mcpEditingTypes";
export type McpPreferences = {
  allowImages: boolean;
  allowEditing: boolean;
  allowProcessing?: boolean;
  autoStart: boolean;
};
/** First-use defaults only. Persisted choices and existing grants are not expanded. */
export const DEFAULT_MCP_PREFERENCES: Readonly<McpPreferences> = Object.freeze({
  allowImages: true,
  allowEditing: true,
  allowProcessing: true,
  autoStart: true,
});
export type McpConnection = {
  id: string;
  clientName: string;
  scope: string;
  createdAt: number;
  revoked: boolean;
};
export type McpPairingRequest = {
  id: string;
  clientName: string;
  code: string;
  scope: string;
  expiresAt: number;
};
export type McpDesktopStatus = {
  state: "off" | "starting" | "online" | "stopping" | "error";
  provider: "tailscale";
  url: string | null;
  message: string | null;
  setupUrl: string | null;
  preferences: McpPreferences;
  pending: McpPairingRequest[];
  connections: McpConnection[];
};
export type McpDiagnostics = {
  ok: boolean;
  checks: { name: string; passed: boolean; message: string }[];
};
export type McpDesktopControl = {
  reportEditorState: (state: McpEditorState) => Promise<{ completed: boolean }>;
  getStatus: () => Promise<McpDesktopStatus>;
  setEnabled: (enabled: boolean) => Promise<McpDesktopStatus>;
  configure: (preferences: McpPreferences) => Promise<McpDesktopStatus>;
  resolvePairing: (id: string, approve: boolean) => Promise<McpDesktopStatus>;
  revokeConnection: (id: string) => Promise<McpDesktopStatus>;
  diagnose: () => Promise<McpDiagnostics>;
};
