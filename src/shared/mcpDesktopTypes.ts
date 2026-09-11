export type McpPreferences = {
  allowImages: boolean;
  allowEditing: boolean;
  autoStart: boolean;
};
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
  pairingUntil: number | null;
  pending: McpPairingRequest[];
  connections: McpConnection[];
};
export type McpDiagnostics = {
  ok: boolean;
  checks: { name: string; passed: boolean; message: string }[];
};
export type McpDesktopControl = {
  getStatus: () => Promise<McpDesktopStatus>;
  setEnabled: (enabled: boolean) => Promise<McpDesktopStatus>;
  configure: (preferences: McpPreferences) => Promise<McpDesktopStatus>;
  beginPairing: () => Promise<McpDesktopStatus>;
  resolvePairing: (id: string, approve: boolean) => Promise<McpDesktopStatus>;
  revokeConnection: (id: string) => Promise<McpDesktopStatus>;
  diagnose: () => Promise<McpDiagnostics>;
};
