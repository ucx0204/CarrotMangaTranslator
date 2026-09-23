import { z } from "zod";
import {
  PAGE_WORKFLOW_STAGES,
  type PageWorkflowStage,
} from "./pageWorkflowStages";
const StageSchema = z.enum(PAGE_WORKFLOW_STAGES);
export type PageWorkflowFinding = { blockId: string; rule: string };
type PageWorkflowStepReceipt = {
  status: "completed" | "failed" | "empty";
  inputKey: string;
  outputKey: string;
  resumeKey?: string;
  configurationKey?: string;
  message?: string;
  /** Read compatibility for early development receipts; no longer used. */
  retryBlockIds?: string[];
};
export type PageWorkflowReceipt = {
  runId: string;
  planKey: string;
  emptyDetectionKey?: string;
  steps: Partial<Record<PageWorkflowStage, PageWorkflowStepReceipt>>;
  findings: PageWorkflowFinding[];
};
export const PageWorkflowReceiptSchema: z.ZodType<PageWorkflowReceipt> = z
  .object({
    runId: z.string().uuid(),
    planKey: z.string().max(100),
    emptyDetectionKey: z.string().max(100).optional(),
    steps: z.record(
      StageSchema,
      z
        .object({
          status: z.enum(["completed", "failed", "empty"]),
          inputKey: z.string().max(100),
          outputKey: z.string().max(100),
          resumeKey: z.string().max(100).optional(),
          configurationKey: z.string().max(100).optional(),
          message: z.string().max(4000).optional(),
          retryBlockIds: z.array(z.string().max(200)).max(10000).optional(),
        })
        .strict(),
    ),
    findings: z
      .array(
        z
          .object({ blockId: z.string().max(200), rule: z.string().max(200) })
          .strict(),
      )
      .max(10000),
  })
  .strict();
