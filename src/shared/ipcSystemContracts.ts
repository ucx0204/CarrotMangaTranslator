import { z } from "zod";
import type { PanelCommand, PanelId, PanelSyncState } from "./panelBridgeTypes";
import {
  PanelCommandSchema,
  PanelIdSchema,
  PanelSyncStateSchema,
} from "./panelBridgeSchemas";
import { defineIpcContract, localPathResult } from "./ipcContractCore";
import type { DiscoverableApiProviderId } from "./apiProviderPresets";
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
  })
  .strict();
const discoverableApiProviderSchema = z.enum([
  "nvidia-nim",
  "google-ai-studio",
  "google-vertex",
  "openrouter",
]);

export const externalIpcContracts = {
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
    { currentVersion: string; releasesUrl: string }
  >({
    apiKey: "getAppUpdateInfo",
    channel: "external:get-update-info",
    args: z.tuple([]),
    result: appUpdateInfoResultSchema,
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
