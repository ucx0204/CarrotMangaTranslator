import { z } from "zod";
import { defineIpcContract } from "./ipcContractCore";
import { ChapterSnapshotSchema } from "./ipcLibrarySchemas";
import {
  PageWorkflowPlanSchema,
  type PageWorkflowRequest,
  type PageWorkflowPreflight,
  type PageWorkflowResult,
} from "./pageWorkflowTypes";
import { PAGE_WORKFLOW_STAGES } from "./pageWorkflowStages";

export const PageWorkflowRequestSchema = z
  .object({
    plan: PageWorkflowPlanSchema,
    selection: z
      .array(
        z
          .object({
            chapterId: z.string().uuid(),
            pageIds: z.array(z.string().uuid()).min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    resumeRunId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      new Set(request.selection.map((s) => s.chapterId)).size !==
        request.selection.length ||
      request.selection.some(
        (s) => new Set(s.pageIds).size !== s.pageIds.length,
      )
    )
      ctx.addIssue({ code: "custom", message: "중복된 작업 대상입니다." });
  });
const IssueSchema = z
  .object({
    chapterId: z.string(),
    pageId: z.string().optional(),
    stage: z.enum(PAGE_WORKFLOW_STAGES).optional(),
    message: z.string(),
  })
  .strict();
export const pageWorkflowIpcContracts = {
  preflightPageWorkflow: defineIpcContract<
    [PageWorkflowRequest],
    PageWorkflowPreflight
  >({
    apiKey: "preflightPageWorkflow",
    channel: "page-workflow:preflight",
    args: z.tuple([PageWorkflowRequestSchema]),
    result: z
      .object({
        ruleEffects: z
          .array(
            z
              .object({
                stage: z.enum([
                  "source-rules",
                  "translation-rules",
                  "format-rules",
                ]),
                name: z.string(),
                fields: z.array(z.string()),
              })
              .strict(),
          )
          .optional(),
        issues: z.array(IssueSchema),
        counts: z.array(
          z
            .object({
              stage: z.enum(PAGE_WORKFLOW_STAGES),
              process: z.number(),
              preserve: z.number(),
              empty: z.number(),
            })
            .strict(),
        ),
        pageCount: z.number(),
      })
      .strict(),
  }),
  startPageWorkflow: defineIpcContract<
    [PageWorkflowRequest],
    PageWorkflowResult
  >({
    apiKey: "startPageWorkflow",
    channel: "page-workflow:start",
    args: z.tuple([PageWorkflowRequestSchema]),
    result: z
      .object({
        runId: z.string().uuid(),
        status: z.enum(["completed", "partial", "cancelled", "failed"]),
        chapters: z.array(ChapterSnapshotSchema),
        issues: z.array(IssueSchema),
      })
      .strict(),
  }),
  getPageWorkflowRun: defineIpcContract<[string], PageWorkflowRequest>({
    apiKey: "getPageWorkflowRun",
    channel: "page-workflow:get-run",
    args: z.tuple([z.string().uuid()]),
    result: PageWorkflowRequestSchema,
  }),
};
