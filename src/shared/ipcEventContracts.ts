import { z } from "zod";
import type { JobEvent, ModelTestProgressEvent } from "./jobTypes";
import { JobEventSchema, ModelTestProgressEventSchema } from "./ipcSchemas";
import {
  PanelCommandSchema,
  PanelIdSchema,
  PanelSyncStateSchema,
} from "./panelBridgeSchemas";
import type { PanelCommand, PanelId, PanelSyncState } from "./panelBridgeTypes";
import { SUPPORTED_UI_LOCALES, type UiLocale } from "./uiLocales";
import { defineIpcEventContract } from "./ipcContractCore";
import type { FontLibrarySnapshot } from "./libraryTypes";
import { FontLibrarySnapshotSchema } from "./ipcContextSettingsContracts";
import type { ErrorReportContext } from "./errorReportTypes";
import { ErrorReportContextSchema } from "./errorReportSchemas";
import { webImportIpcEventContracts } from "./ipcWebImportContracts";
import type { LinkedWorkspaceStatusChangedEvent } from "./linkedWorkspaceTypes";
import { LinkedWorkspaceStatusSchema } from "./linkedWorkspaceSchemas";
import type { PageTimingUpdatedEvent } from "./pageProcessingTiming";
import { MAX_ID_LIST_LENGTH, uuid } from "./ipcSchemaPrimitives";
import type { AppOperationActivityEvent } from "./appOperationTypes";
import { AppOperationActivityEventSchema } from "./ipcAppOperationContracts";

export const ipcEventContracts = {
  ...webImportIpcEventContracts,
  appOperationActivity: defineIpcEventContract<AppOperationActivityEvent>({
    eventKey: "appOperationActivity",
    channel: "app-operation:activity",
    payload: AppOperationActivityEventSchema,
  }),
  linkedWorkspaceStatusChanged:
    defineIpcEventContract<LinkedWorkspaceStatusChangedEvent>({
      eventKey: "linkedWorkspaceStatusChanged",
      channel: "linked-workspace:status-changed",
      payload: z
        .object({ statuses: z.array(LinkedWorkspaceStatusSchema).max(2000) })
        .strict(),
    }),
  errorIncident: defineIpcEventContract<ErrorReportContext>({
    eventKey: "errorIncident",
    channel: "error-report:incident",
    payload: ErrorReportContextSchema,
  }),
  fontLibraryChanged: defineIpcEventContract<FontLibrarySnapshot>({
    eventKey: "fontLibraryChanged",
    channel: "fonts:library-changed",
    payload: FontLibrarySnapshotSchema,
  }),
  uiLocaleChanged: defineIpcEventContract<UiLocale>({
    eventKey: "uiLocaleChanged",
    channel: "settings:ui-locale-changed",
    payload: z.enum(SUPPORTED_UI_LOCALES),
  }),
  pageTimingUpdated: defineIpcEventContract<PageTimingUpdatedEvent>({
    eventKey: "pageTimingUpdated",
    channel: "page-timing:updated",
    payload: z
      .object({
        chapterId: uuid,
        pageIds: z.array(uuid).max(MAX_ID_LIST_LENGTH),
      })
      .strict(),
  }),
  jobEvent: defineIpcEventContract<JobEvent>({
    eventKey: "jobEvent",
    channel: "job:event",
    payload: JobEventSchema,
  }),
  modelTestProgress: defineIpcEventContract<ModelTestProgressEvent>({
    eventKey: "modelTestProgress",
    channel: "settings:model-test-progress",
    payload: ModelTestProgressEventSchema,
  }),
  panelState: defineIpcEventContract<PanelSyncState>({
    eventKey: "panelState",
    channel: "panel:state",
    payload: PanelSyncStateSchema,
  }),
  panelCommand: defineIpcEventContract<PanelCommand>({
    eventKey: "panelCommand",
    channel: "panel:command",
    payload: PanelCommandSchema,
  }),
  panelWindowsChanged: defineIpcEventContract<PanelId[]>({
    eventKey: "panelWindowsChanged",
    channel: "panel:windows-changed",
    payload: z.array(PanelIdSchema).max(32),
  }),
} as const;
