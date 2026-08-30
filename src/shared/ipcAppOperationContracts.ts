import { z } from "zod";
import type {
  AppOperationActivityEvent,
  AppOperationCancelResult,
} from "./appOperationTypes";
import {
  APP_OPERATION_KINDS,
  APP_OPERATION_PHASES,
  APP_OPERATION_PROGRESS_UNITS,
  APP_OPERATION_STATUSES,
} from "./appOperationTypes";
import { defineIpcContract } from "./ipcContractCore";

const operationIdSchema = z.string().min(1).max(240);

export const AppOperationActivityEventSchema: z.ZodType<AppOperationActivityEvent> =
  z
    .object({
      id: operationIdSchema,
      kind: z.enum(APP_OPERATION_KINDS),
      status: z.enum(APP_OPERATION_STATUSES),
      phase: z.enum(APP_OPERATION_PHASES).optional(),
      sourceKind: z
        .enum(["images", "folder", "zip", "rar", "pdf", "zip-folder"])
        .optional(),
      progressCurrent: z.number().finite().nonnegative().optional(),
      progressTotal: z.number().finite().positive().optional(),
      progressUnit: z.enum(APP_OPERATION_PROGRESS_UNITS).optional(),
      waitingForUser: z.boolean().optional(),
      failureCode: z
        .string()
        .regex(/^[A-Z0-9_-]{1,80}$/)
        .optional(),
      mutatesLibrary: z.boolean(),
      cancellable: z.boolean(),
      startedAt: z.number().finite().nonnegative(),
      updatedAt: z.number().finite().nonnegative(),
    })
    .strict();

const cancelResultSchema: z.ZodType<AppOperationCancelResult> = z
  .object({ accepted: z.boolean() })
  .strict();

export const appOperationIpcContracts = {
  getActiveAppOperation: defineIpcContract<
    [],
    AppOperationActivityEvent | null
  >({
    apiKey: "getActiveAppOperation",
    channel: "app-operation:get-active",
    args: z.tuple([]),
    result: AppOperationActivityEventSchema.nullable(),
  }),
  cancelAppOperation: defineIpcContract<[string], AppOperationCancelResult>({
    apiKey: "cancelAppOperation",
    channel: "app-operation:cancel",
    args: z.tuple([operationIdSchema]),
    result: cancelResultSchema,
  }),
} as const;
