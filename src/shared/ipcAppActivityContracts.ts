import { z } from "zod";
import { defineIpcContract } from "./ipcContractCore";
import type {
  AppActivityState,
  PageEditHandoffResponse,
} from "./appActivityTypes";
import type { JobEvent } from "./jobTypes";
import { JobEventSchema } from "./ipcJobSchemas";

export const AppActivityStateSchema: z.ZodType<AppActivityState> = z
  .object({
    version: z.number().int().nonnegative(),
    activities: z.array(
      z
        .object({
          id: z.string(),
          ownerId: z.string().optional(),
          category: z.enum(["job", "operation"]),
          kind: z.string(),
          mutatesLibrary: z.boolean(),
          blocksQuit: z.boolean(),
          startedAt: z.number(),
          resources: z
            .array(
              z
                .object({
                  kind: z.enum([
                    "model-runtime",
                    "codex-auth",
                    "page-content",
                    "library-structure",
                    "work-context",
                    "output-path",
                  ]),
                  scope: z.string(),
                  access: z.enum(["read", "write"]),
                })
                .strict(),
            )
            .optional(),
        })
        .strict(),
    ),
    pages: z.array(
      z
        .object({
          jobId: z.string(),
          chapterId: z.string(),
          pageId: z.string(),
          phase: z.enum([
            "queued",
            "finishing-edits",
            "waiting",
            "processing",
            "completed",
            "failed",
          ]),
          requestId: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const responseSchema: z.ZodType<PageEditHandoffResponse> = z
  .object({
    requestId: z.string().uuid(),
    error: z.string().max(2000).optional(),
  })
  .strict();

export const appActivityIpcContracts = {
  getActiveJobs: defineIpcContract<[], JobEvent[]>({
    apiKey: "getActiveJobs",
    channel: "app-activity:jobs",
    args: z.tuple([]),
    result: z.array(JobEventSchema),
  }),
  getAppActivities: defineIpcContract<[], AppActivityState>({
    apiKey: "getAppActivities",
    channel: "app-activity:get",
    args: z.tuple([]),
    result: AppActivityStateSchema,
  }),
  finishPageEditHandoff: defineIpcContract<[PageEditHandoffResponse], boolean>({
    apiKey: "finishPageEditHandoff",
    channel: "page-edit:finish-handoff",
    args: z.tuple([responseSchema]),
    result: z.boolean(),
  }),
  retryPageEditHandoff: defineIpcContract<[string], boolean>({
    apiKey: "retryPageEditHandoff",
    channel: "page-edit:retry-handoff",
    args: z.tuple([z.string().uuid()]),
    result: z.boolean(),
  }),
} as const;
