import type { McpEditorState } from "./mcpEditingTypes";
import { z } from "zod";
import { defineIpcContract } from "./ipcContractCore";
import type {
  McpDesktopStatus,
  McpDiagnostics,
  McpPreferences,
} from "./mcpDesktopTypes";
const mcpPreferencesSchema = z
  .object({
    allowImages: z.boolean(),
    allowEditing: z.boolean(),
    allowProcessing: z.boolean().optional(),
    autoStart: z.boolean(),
  })
  .strict();
const status = z
  .object({
    state: z.enum(["off", "starting", "online", "stopping", "error"]),
    provider: z.literal("tailscale"),
    url: z.string().url().nullable(),
    message: z.string().nullable(),
    setupUrl: z.string().url().nullable(),
    preferences: mcpPreferencesSchema,
    pairingUntil: z.number().nullable(),
    pending: z.array(
      z
        .object({
          id: z.string(),
          clientName: z.string(),
          code: z.string(),
          scope: z.string(),
          expiresAt: z.number(),
        })
        .strict(),
    ),
    connections: z.array(
      z
        .object({
          id: z.string().uuid(),
          clientName: z.string(),
          scope: z.string(),
          createdAt: z.number(),
          revoked: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export const mcpIpcContracts = {
  reportMcpEditorState: defineIpcContract<
    [McpEditorState],
    { completed: boolean }
  >({
    apiKey: "reportMcpEditorState",
    channel: "mcp:editor-state",
    args: z.tuple([
      z
        .object({
          probeId: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
          chapterId: z.string().uuid().nullable(),
          dirtyPageIds: z.array(z.string().uuid()).max(10000),
          hasPendingInpaintingMask: z.boolean(),
        })
        .strict(),
    ]),
    result: z.object({ completed: z.boolean() }).strict(),
  }),
  getMcpStatus: defineIpcContract<[], McpDesktopStatus>({
    apiKey: "getMcpStatus",
    channel: "mcp:status",
    args: z.tuple([]),
    result: status,
  }),
  setMcpEnabled: defineIpcContract<[boolean], McpDesktopStatus>({
    apiKey: "setMcpEnabled",
    channel: "mcp:enabled",
    args: z.tuple([z.boolean()]),
    result: status,
  }),
  configureMcp: defineIpcContract<[McpPreferences], McpDesktopStatus>({
    apiKey: "configureMcp",
    channel: "mcp:configure",
    args: z.tuple([mcpPreferencesSchema]),
    result: status,
  }),
  beginMcpPairing: defineIpcContract<[], McpDesktopStatus>({
    apiKey: "beginMcpPairing",
    channel: "mcp:pairing-open",
    args: z.tuple([]),
    result: status,
  }),
  resolveMcpPairing: defineIpcContract<[string, boolean], McpDesktopStatus>({
    apiKey: "resolveMcpPairing",
    channel: "mcp:pairing-resolve",
    args: z.tuple([z.string().regex(/^[A-Za-z0-9_-]{43}$/), z.boolean()]),
    result: status,
  }),
  revokeMcpConnection: defineIpcContract<[string], McpDesktopStatus>({
    apiKey: "revokeMcpConnection",
    channel: "mcp:revoke",
    args: z.tuple([z.string().uuid()]),
    result: status,
  }),
  diagnoseMcp: defineIpcContract<[], McpDiagnostics>({
    apiKey: "diagnoseMcp",
    channel: "mcp:diagnose",
    args: z.tuple([]),
    result: z
      .object({
        ok: z.boolean(),
        checks: z.array(
          z
            .object({
              name: z.string(),
              passed: z.boolean(),
              message: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  }),
  openMcpHelp: defineIpcContract<
    ["tailscale" | "setup" | "chatgpt"],
    { completed: boolean }
  >({
    apiKey: "openMcpHelp",
    channel: "mcp:open-help",
    args: z.tuple([z.enum(["tailscale", "setup", "chatgpt"])]),
    result: z.object({ completed: z.boolean() }).strict(),
  }),
  copyMcpUrl: defineIpcContract<[], { completed: boolean }>({
    apiKey: "copyMcpUrl",
    channel: "mcp:copy-url",
    args: z.tuple([]),
    result: z.object({ completed: z.boolean() }).strict(),
  }),
};
