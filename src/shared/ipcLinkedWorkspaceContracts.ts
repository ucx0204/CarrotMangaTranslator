import { z } from "zod";
import type {
  ConnectLinkedWorkspaceRequest,
  LinkedWorkspaceActivityRequest,
  LinkedWorkspaceBooleanResult,
  LinkedWorkspaceStatus,
  UpdateLinkedWorkspaceRequest,
  ViewLinkedResultsRequest,
  ViewLinkedResultsResult,
} from "./linkedWorkspaceTypes";
import { defineIpcContract } from "./ipcContractCore";
import {
  ConnectLinkedWorkspaceRequestSchema,
  LinkedWorkspaceActivityRequestSchema,
  LinkedWorkspaceStatusSchema,
  UpdateLinkedWorkspaceRequestSchema,
  ViewLinkedResultsRequestSchema,
} from "./linkedWorkspaceSchemas";

const booleanResultSchema = z.object({ completed: z.boolean() }).strict();
const viewResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("opened"),
      syncedPages: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z
    .object({ status: z.literal("failed"), message: z.string().max(4000) })
    .strict(),
]);
export const linkedWorkspaceIpcContracts = {
  getLinkedWorkspaceStatus: defineIpcContract<[string], LinkedWorkspaceStatus>({
    apiKey: "getLinkedWorkspaceStatus",
    channel: "linked-workspace:get-status",
    args: z.tuple([z.string().uuid()]),
    result: LinkedWorkspaceStatusSchema,
  }),
  listLinkedWorkspaceStatuses: defineIpcContract<
    [string[]],
    LinkedWorkspaceStatus[]
  >({
    apiKey: "listLinkedWorkspaceStatuses",
    channel: "linked-workspace:list-statuses",
    args: z.tuple([z.array(z.string().uuid()).max(20_000)]),
    result: z.array(LinkedWorkspaceStatusSchema).max(20_000),
  }),
  connectLinkedWorkspace: defineIpcContract<
    [ConnectLinkedWorkspaceRequest],
    LinkedWorkspaceStatus | null
  >({
    apiKey: "connectLinkedWorkspace",
    channel: "linked-workspace:connect",
    args: z.tuple([ConnectLinkedWorkspaceRequestSchema]),
    result: LinkedWorkspaceStatusSchema.nullable(),
  }),
  updateLinkedWorkspace: defineIpcContract<
    [UpdateLinkedWorkspaceRequest],
    LinkedWorkspaceStatus
  >({
    apiKey: "updateLinkedWorkspace",
    channel: "linked-workspace:update",
    args: z.tuple([UpdateLinkedWorkspaceRequestSchema]),
    result: LinkedWorkspaceStatusSchema,
  }),
  reconnectLinkedWorkspace: defineIpcContract<
    [string],
    LinkedWorkspaceStatus | null
  >({
    apiKey: "reconnectLinkedWorkspace",
    channel: "linked-workspace:reconnect",
    args: z.tuple([z.string().uuid()]),
    result: LinkedWorkspaceStatusSchema.nullable(),
  }),
  resetLinkedWorkspaceLocation: defineIpcContract<
    [string],
    LinkedWorkspaceStatus
  >({
    apiKey: "resetLinkedWorkspaceLocation",
    channel: "linked-workspace:reset-location",
    args: z.tuple([z.string().uuid()]),
    result: LinkedWorkspaceStatusSchema,
  }),
  disconnectLinkedWorkspace: defineIpcContract<
    [string],
    LinkedWorkspaceBooleanResult
  >({
    apiKey: "disconnectLinkedWorkspace",
    channel: "linked-workspace:disconnect",
    args: z.tuple([z.string().uuid()]),
    result: booleanResultSchema,
  }),
  viewLinkedResults: defineIpcContract<
    [ViewLinkedResultsRequest],
    ViewLinkedResultsResult
  >({
    apiKey: "viewLinkedResults",
    channel: "linked-workspace:view-results",
    args: z.tuple([ViewLinkedResultsRequestSchema]),
    result: viewResultSchema,
  }),
  reportLinkedWorkspaceActivity: defineIpcContract<
    [LinkedWorkspaceActivityRequest],
    LinkedWorkspaceBooleanResult
  >({
    apiKey: "reportLinkedWorkspaceActivity",
    channel: "linked-workspace:activity",
    args: z.tuple([LinkedWorkspaceActivityRequestSchema]),
    result: booleanResultSchema,
  }),
} as const;
