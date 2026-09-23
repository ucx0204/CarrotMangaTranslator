import {
  PAGE_WORKFLOW_STAGES,
  PAGE_WORKFLOW_STAGE_LABELS,
  type PageWorkflowStage,
} from "./pageWorkflowStages";
import type { PageWorkflowFinding } from "./pageWorkflowReceipt";
import { z } from "zod";
import type { ChapterSnapshot } from "./libraryTypes";
import type { ConditionalBatchSchemeDraftV2 } from "./conditionalBatchRules";
import type { GlossaryEntry } from "./workContextTypes";

const StageSchema = z.enum(PAGE_WORKFLOW_STAGES);
const RuleReferenceSchema = z
  .object({
    kind: z.enum(["scheme", "sequence"]),
    id: z.string().min(1).max(200),
  })
  .strict();
export const PageWorkflowPlanSchema = z
  .object({
    version: z.literal(1),
    stages: z.array(StageSchema).min(1).max(PAGE_WORKFLOW_STAGES.length),
    overwrite: z
      .array(StageSchema)
      .max(PAGE_WORKFLOW_STAGES.length)
      .default([]),
    rules: z
      .object({
        "source-rules": RuleReferenceSchema.optional(),
        "translation-rules": RuleReferenceSchema.optional(),
        "format-rules": RuleReferenceSchema.optional(),
      })
      .strict()
      .default({}),
    cumulative: z.boolean().default(true),
    cumulativeDetail: z
      .enum(["detailed", "balanced", "essential"])
      .default("detailed"),
    autoFont: z.boolean().default(true),
    autoSize: z.boolean().default(true),
    bubbleLayout: z.boolean().default(true),
    naturalLayout: z.boolean().default(false),
    erasureEngine: z.enum(["local", "codex"]).default("local"),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (new Set(plan.stages).size !== plan.stages.length)
      ctx.addIssue({ code: "custom", message: "작업 단계가 중복되었습니다." });
    for (const stage of [
      "source-rules",
      "translation-rules",
      "format-rules",
    ] as const)
      if (plan.stages.includes(stage) && !plan.rules[stage])
        ctx.addIssue({
          code: "custom",
          message: `${PAGE_WORKFLOW_STAGE_LABELS[stage]} 규칙을 선택하세요.`,
        });
  });
export type PageWorkflowPlan = z.infer<typeof PageWorkflowPlanSchema>;
export type PageWorkflowRuleStage = keyof PageWorkflowPlan["rules"];
export type FrozenPageWorkflowRules = Partial<
  Record<PageWorkflowRuleStage, ConditionalBatchSchemeDraftV2[]>
>;

export type PageWorkflowRequest = {
  plan: PageWorkflowPlan;
  selection: Array<{ chapterId: string; pageIds: string[] }>;
  resumeRunId?: string;
};
export type PageWorkflowIssue = {
  chapterId: string;
  pageId?: string;
  stage?: PageWorkflowStage;
  message: string;
};
export type PageWorkflowPreflight = {
  ruleEffects?: Array<{
    stage: PageWorkflowRuleStage;
    name: string;
    fields: string[];
  }>;
  issues: PageWorkflowIssue[];
  counts: Array<{
    stage: PageWorkflowStage;
    process: number;
    preserve: number;
    empty: number;
  }>;
  pageCount: number;
};
export type PageWorkflowResult = {
  runId: string;
  status: "completed" | "partial" | "cancelled" | "failed";
  chapters: ChapterSnapshot[];
  issues: PageWorkflowIssue[];
};
export type PageWorkflowRuleRenderRequest = {
  chapter: ChapterSnapshot;
  pageId: string;
  schemes: ConditionalBatchSchemeDraftV2[];
  glossary: GlossaryEntry[];
  inspect: boolean;
};
export type PageWorkflowRuleRenderResult = {
  chapter: ChapterSnapshot;
  findings: PageWorkflowFinding[];
};
export const PageWorkflowPresetSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(80),
    plan: PageWorkflowPlanSchema,
  })
  .strict();
export type PageWorkflowPreset = z.infer<typeof PageWorkflowPresetSchema>;
export const PageWorkflowFavoritePresetIdsSchema = z
  .array(z.string().min(1).max(200))
  .max(55);

export function createPageWorkflowPlan(
  stages: PageWorkflowStage[],
): PageWorkflowPlan {
  return PageWorkflowPlanSchema.parse({ version: 1, stages });
}
export function pageWorkflowPresets(): PageWorkflowPreset[] {
  return [
    {
      id: "full",
      name: "전체 처리",
      plan: createPageWorkflowPlan([
        "detect",
        "ocr",
        "translate",
        "typography",
        "erase",
        "layout",
        "review",
      ]),
    },
    {
      id: "manual",
      name: "손번역 준비",
      plan: createPageWorkflowPlan(["detect", "ocr", "erase"]),
    },
    {
      id: "erase",
      name: "원문 제거만",
      plan: createPageWorkflowPlan(["detect", "erase"]),
    },
    {
      id: "translate",
      name: "번역만",
      plan: createPageWorkflowPlan(["translate", "review"]),
    },
    {
      id: "finish",
      name: "식자 마무리",
      plan: createPageWorkflowPlan(["typography", "erase", "layout", "review"]),
    },
  ];
}
