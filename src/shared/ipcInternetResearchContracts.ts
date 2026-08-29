import { z } from "zod";
import type {
  TavilyUsageRequest,
  TavilyUsageSnapshot,
} from "./internetResearchTypes";
import { RESEARCH_ENGINES } from "./internetResearchTypes";
import {
  CharacterProfileSchema,
  GlossaryEntrySchema,
  ResearchWorkContextRequestSchema,
} from "./ipcSchemas";
import {
  defineIpcContract,
  diagnosticString,
  MAX_WARNINGS,
  nonNegativeInteger,
  stringArg,
} from "./ipcContractCore";
import type {
  ResearchWorkContextRequest,
  WorkContextResearchProposal,
} from "./workContextResearchTypes";

const researchSourceSchema = z
  .object({
    title: z.string().max(500),
    url: z.string().url().max(2_000),
  })
  .strict();

const researchEvidenceSchema = z
  .object({
    pageCount: nonNegativeInteger,
    mentionCount: nonNegativeInteger,
    sample: z.string().max(1_000).optional(),
  })
  .strict();

const researchOperationBase = {
  id: stringArg,
  action: z.enum(["add", "update", "disable"]),
  reason: z.string().max(2_000),
  confidence: z.enum(["high", "medium"]),
  selectedByDefault: z.boolean(),
  evidence: researchEvidenceSchema,
  sources: z.array(researchSourceSchema).max(20),
};

const researchOperationSchema = z.discriminatedUnion("entity", [
  z
    .object({
      ...researchOperationBase,
      entity: z.literal("glossary"),
      before: GlossaryEntrySchema.optional(),
      after: GlossaryEntrySchema,
    })
    .strict(),
  z
    .object({
      ...researchOperationBase,
      entity: z.literal("character"),
      before: CharacterProfileSchema.optional(),
      after: CharacterProfileSchema,
    })
    .strict(),
]);

const researchProposalSchema = z
  .object({
    engine: z.enum(RESEARCH_ENGINES),
    baseFingerprint: z.string().min(1).max(100),
    operations: z.array(researchOperationSchema).max(1_300),
    warnings: z.array(diagnosticString).max(MAX_WARNINGS),
    stats: z
      .object({
        queryCount: nonNegativeInteger,
        sourceCount: nonNegativeInteger,
        tavilyCreditsUsed: nonNegativeInteger,
        estimatedTokenDelta: z.number().int(),
        elapsedMs: nonNegativeInteger,
      })
      .strict(),
  })
  .strict();

export const workContextResearchIpcContracts = {
  researchWorkContext: defineIpcContract<
    [ResearchWorkContextRequest],
    WorkContextResearchProposal
  >({
    apiKey: "researchWorkContext",
    channel: "context:research-work-context",
    args: z.tuple([ResearchWorkContextRequestSchema]),
    result: researchProposalSchema,
  }),
  cancelWorkContextResearch: defineIpcContract<
    [string],
    { cancelled: boolean }
  >({
    apiKey: "cancelWorkContextResearch",
    channel: "context:cancel-work-context-research",
    args: z.tuple([stringArg]),
    result: z.object({ cancelled: z.boolean() }).strict(),
  }),
} as const;

const tavilyUsageRequestSchema = z
  .object({
    apiKey: z.string().max(512).optional(),
    force: z.boolean().optional(),
  })
  .strict();

const tavilyUsageSnapshotSchema = z
  .object({
    configured: z.boolean(),
    key: z
      .object({
        used: nonNegativeInteger,
        limit: nonNegativeInteger,
        remaining: nonNegativeInteger,
        searchUsed: nonNegativeInteger,
      })
      .strict()
      .nullable(),
    account: z
      .object({
        plan: z.string().max(120),
        used: nonNegativeInteger,
        limit: nonNegativeInteger,
        remaining: nonNegativeInteger,
        paygoUsed: nonNegativeInteger,
        paygoLimit: nonNegativeInteger,
      })
      .strict()
      .nullable(),
    fetchedAt: z.string().max(80),
  })
  .strict();

export const tavilySettingsIpcContracts = {
  getTavilyUsage: defineIpcContract<
    [request?: TavilyUsageRequest],
    TavilyUsageSnapshot
  >({
    apiKey: "getTavilyUsage",
    channel: "settings:tavily-usage",
    args: z.union([z.tuple([]), z.tuple([tavilyUsageRequestSchema])]),
    result: tavilyUsageSnapshotSchema,
  }),
} as const;
