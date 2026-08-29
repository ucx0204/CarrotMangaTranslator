import { z } from "zod";
import type { PanelCommand, PanelId, PanelSyncState } from "./panelBridgeTypes";
import {
  PanelCommandSchema,
  PanelIdSchema,
  PanelSyncStateSchema,
} from "./panelBridgeSchemas";
import { defineIpcContract, localPathResult } from "./ipcContractCore";
import {
  VERTEX_SETUP_PAGE_IDS,
  type DiscoverableApiProviderId,
  type VertexSetupPageId,
} from "./apiProviderPresets";
import {
  CopyErrorReportBodySchema,
  CopyErrorReportResultSchema,
  ErrorReportContextSchema,
  ErrorReportDraftSchema,
  OpenErrorReportIssueRequestSchema,
  OpenErrorReportIssueResultSchema,
  RestartAppResultSchema,
} from "./errorReportSchemas";
import type {
  CopyErrorReportResult,
  ErrorReportContext,
  ErrorReportDraft,
  OpenErrorReportIssueRequest,
  OpenErrorReportIssueResult,
  RestartAppResult,
} from "./errorReportTypes";
import type { BuildChannel, RuntimeCapabilities } from "./runtimeCapabilities";

const openedUrlResultSchema = z
  .object({
    opened: z.boolean(),
    url: z.string().min(1).max(2000),
  })
  .strict();
const appUpdateInfoResultSchema = z
  .object({
    currentVersion: z.string().min(1).max(64),
    releasesUrl: z.string().min(1).max(2000),
    buildChannel: z.enum(["stable", "mac-alpha"]),
  })
  .strict();
const runtimeCapabilitiesResultSchema: z.ZodType<RuntimeCapabilities> = z
  .object({
    buildChannel: z.enum(["stable", "mac-alpha"]),
    platform: z.string().min(1).max(32),
    arch: z.string().min(1).max(32),
    appleSilicon: z.boolean(),
    gpuVendor: z.enum(["nvidia", "amd", "apple", "unknown"]),
    gpuName: z.string().max(500).nullable(),
    supportsMetal: z.boolean(),
    unifiedMemoryMb: z.number().int().positive().nullable(),
    localGemma: z
      .object({
        available: z.boolean(),
        metal: z.boolean(),
        minimumUnifiedMemoryMb: z
          .object({
            minimum12b: z.number().int().positive(),
            economy26b: z.number().int().positive(),
            full31b: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    inpainting: z
      .object({
        fluxKlein: z
          .object({
            available: z.boolean(),
            metal: z.boolean(),
            cpuFallback: z.literal(false),
            minimumUnifiedMemoryMb: z.number().int().positive(),
          })
          .strict(),
        lamaManga: z
          .object({
            available: z.boolean(),
            metal: z.boolean(),
            cpuFallback: z.literal(true),
          })
          .strict(),
        aotInpainting: z
          .object({
            available: z.boolean(),
            metal: z.boolean(),
            cpuFallback: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    ocr: z.object({ cpu: z.literal(true), gpu: z.boolean() }).strict(),
  })
  .strict();
const discoverableApiProviderSchema = z.enum([
  "nvidia-nim",
  "google-ai-studio",
  "google-vertex",
  "openrouter",
  "ollama",
]);
const vertexSetupPageSchema = z.enum(VERTEX_SETUP_PAGE_IDS);

export const externalIpcContracts = {
  openResearchSource: defineIpcContract<
    [string],
    { opened: boolean; url: string }
  >({
    apiKey: "openResearchSource",
    channel: "external:open-research-source",
    args: z.tuple([z.string().url().max(2_000)]),
    result: openedUrlResultSchema,
  }),
  openAmdHipSdkDownload: defineIpcContract<
    [],
    { opened: boolean; url: string }
  >({
    apiKey: "openAmdHipSdkDownload",
    channel: "external:open-amd-hip-sdk",
    args: z.tuple([]),
    result: openedUrlResultSchema,
  }),
  getAppUpdateInfo: defineIpcContract<
    [],
    { currentVersion: string; releasesUrl: string; buildChannel: BuildChannel }
  >({
    apiKey: "getAppUpdateInfo",
    channel: "external:get-update-info",
    args: z.tuple([]),
    result: appUpdateInfoResultSchema,
  }),
  getRuntimeCapabilities: defineIpcContract<[], RuntimeCapabilities>({
    apiKey: "getRuntimeCapabilities",
    channel: "system:get-runtime-capabilities",
    args: z.tuple([]),
    result: runtimeCapabilitiesResultSchema,
  }),
  openReleasesPage: defineIpcContract<[], { opened: boolean; url: string }>({
    apiKey: "openReleasesPage",
    channel: "external:open-releases",
    args: z.tuple([]),
    result: openedUrlResultSchema,
  }),
  openApiProviderPage: defineIpcContract<
    [DiscoverableApiProviderId],
    { opened: boolean; url: string }
  >({
    apiKey: "openApiProviderPage",
    channel: "external:open-api-provider-page",
    args: z.tuple([discoverableApiProviderSchema]),
    result: openedUrlResultSchema,
  }),
  openVertexSetupPage: defineIpcContract<
    [VertexSetupPageId],
    { opened: boolean; url: string }
  >({
    apiKey: "openVertexSetupPage",
    channel: "external:open-vertex-setup-page",
    args: z.tuple([vertexSetupPageSchema]),
    result: openedUrlResultSchema,
  }),
} as const;

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const logMessageSchema = z.string().min(1).max(1000);
const writeLogArgsSchema = z.union([
  z.tuple([logLevelSchema, logMessageSchema]),
  z.tuple([logLevelSchema, logMessageSchema, z.unknown()]),
]);
const openLogFolderResultSchema = z
  .object({ opened: z.boolean(), logPath: localPathResult })
  .strict();
const loggedResultSchema = z.object({ logged: z.boolean() }).strict();

export const logsIpcContracts = {
  getLogPath: defineIpcContract<[], string>({
    apiKey: "getLogPath",
    channel: "logs:get-path",
    args: z.tuple([]),
    result: localPathResult,
  }),
  openLogFolder: defineIpcContract<[], { opened: boolean; logPath: string }>({
    apiKey: "openLogFolder",
    channel: "logs:open-folder",
    args: z.tuple([]),
    result: openLogFolderResultSchema,
  }),
  writeLog: defineIpcContract<
    [
      level: "debug" | "info" | "warn" | "error",
      message: string,
      detail?: unknown,
    ],
    { logged: boolean }
  >({
    apiKey: "writeLog",
    channel: "logs:write",
    args: writeLogArgsSchema,
    result: loggedResultSchema,
  }),
} as const;

export const errorReportIpcContracts = {
  prepareErrorReport: defineIpcContract<[ErrorReportContext], ErrorReportDraft>(
    {
      apiKey: "prepareErrorReport",
      channel: "error-report:prepare",
      args: z.tuple([ErrorReportContextSchema]),
      result: ErrorReportDraftSchema,
    },
  ),
  copyErrorReport: defineIpcContract<[string], CopyErrorReportResult>({
    apiKey: "copyErrorReport",
    channel: "error-report:copy",
    args: z.tuple([CopyErrorReportBodySchema]),
    result: CopyErrorReportResultSchema,
  }),
  openErrorReportIssue: defineIpcContract<
    [OpenErrorReportIssueRequest],
    OpenErrorReportIssueResult
  >({
    apiKey: "openErrorReportIssue",
    channel: "error-report:open-issue",
    args: z.tuple([OpenErrorReportIssueRequestSchema]),
    result: OpenErrorReportIssueResultSchema,
  }),
  restartApp: defineIpcContract<[], RestartAppResult>({
    apiKey: "restartApp",
    channel: "error-report:restart-app",
    args: z.tuple([]),
    result: RestartAppResultSchema,
  }),
} as const;

const panelResultSchemas = {
  opened: z.object({ opened: z.boolean() }).strict(),
  closed: z.object({ closed: z.boolean() }).strict(),
  published: z.object({ published: z.boolean() }).strict(),
  sent: z.object({ sent: z.boolean() }).strict(),
};

export const panelWindowIpcContracts = {
  getPanelState: defineIpcContract<[], PanelSyncState | null>({
    apiKey: "getPanelState",
    channel: "panel:get-state",
    args: z.tuple([]),
    result: PanelSyncStateSchema.nullable(),
  }),
  openPanelWindow: defineIpcContract<[PanelId], { opened: boolean }>({
    apiKey: "openPanelWindow",
    channel: "panel:open-window",
    args: z.tuple([PanelIdSchema]),
    result: panelResultSchemas.opened,
  }),
  closePanelWindow: defineIpcContract<[PanelId], { closed: boolean }>({
    apiKey: "closePanelWindow",
    channel: "panel:close-window",
    args: z.tuple([PanelIdSchema]),
    result: panelResultSchemas.closed,
  }),
  publishPanelState: defineIpcContract<
    [PanelSyncState],
    { published: boolean }
  >({
    apiKey: "publishPanelState",
    channel: "panel:publish-state",
    args: z.tuple([PanelSyncStateSchema]),
    result: panelResultSchemas.published,
  }),
  sendPanelCommand: defineIpcContract<[PanelCommand], { sent: boolean }>({
    apiKey: "sendPanelCommand",
    channel: "panel:send-command",
    args: z.tuple([PanelCommandSchema]),
    result: panelResultSchemas.sent,
  }),
} as const;
