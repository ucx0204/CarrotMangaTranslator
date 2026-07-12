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

export const ipcEventContracts = {
  uiLocaleChanged: defineIpcEventContract<UiLocale>({
    eventKey: "uiLocaleChanged",
    channel: "settings:ui-locale-changed",
    payload: z.enum(SUPPORTED_UI_LOCALES),
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
