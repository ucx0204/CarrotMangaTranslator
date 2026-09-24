import {
  McpWorkFileCreateSchema,
  McpWorkFileReceiptSchema,
} from "../../shared/mcpWorkFileImport";
import {
  McpWorkFileExportTargetSchema,
  McpWorkFileExportMetadataSchema,
} from "../../shared/mcpWorkFileExport";
import { McpUploadedImportSchema } from "../../shared/mcpFileUploads";
import { McpImportBatchPublishSchema } from "../../shared/mcpImportPublication";
import {
  McpImportBatchRunSchema,
  McpImportBatchReferenceSchema,
} from "../../shared/mcpImportBatch";
import {
  validMcpJobReferences,
  retainedContextProposalSchema,
  persistedResearchMetadata,
} from "./mcpJobReferencePolicy";
import {
  McpChooseImportSchema,
  McpScanImportSchema,
  McpImportCreateSchema,
  McpImportPreviewReferenceSchema,
  McpImportReceiptSchema,
} from "../../shared/mcpLibraryImport";
import {
  McpDiscoverChaptersSchema,
  McpDiscoveredChapterScanSchema,
  McpChapterDiscoveryReferenceSchema,
} from "../../shared/mcpChapterDiscovery";
import {
  McpSoundEffectPrepareSchema,
  McpSoundEffectPlanReferenceSchema,
} from "../../shared/mcpSoundEffects";
import {
  McpSelectionOcrSchema,
  McpSelectionTranslationSchema,
  McpSelectionAnalysisReferenceSchema,
} from "../../shared/mcpSelectionAnalysis";
import {
  McpLetteringPrepareSchema,
  McpLetteringPlanReferenceSchema,
} from "../../shared/mcpLettering";
import { z } from "zod/v4";
import {
  McpTypographyAnalysisTargetSchema,
  McpTypographyAnalysisObservationSchema,
} from "../../shared/mcpTypographyAnalysis";
import { McpSourceSizeObservationSchema } from "../../shared/mcpSourceSize";
import {
  McpExportPagesTargetSchema,
  McpExportZipTargetSchema,
  McpExportPagesMetadataSchema,
} from "../../shared/mcpExportBatch";
import {
  McpContextResearchTargetSchema,
  McpContextResearchResultSchema,
} from "../../shared/mcpContextEditing";
import { McpBlockTranslationProposalSchema } from "../../shared/mcpBlockTranslation";
import { McpBlockOcrObservationSchema } from "../../shared/mcpBlockOcr";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpSyncOutputSchema } from "../../shared/mcpOutputSync";
import { McpOutputSyncJobReferenceSchema } from "../../shared/mcpOutputSyncJob";
import { validMcpOutputSyncJobResult } from "./mcpOutputSyncJobPolicy";
import {
  mcpExchangeJobTargets,
  mcpExchangeJobTargetSchema,
  mcpExchangeResultFields,
  mcpExchangeMetadataInput,
  validMcpExchangeResultMetadata,
} from "./mcpExchangeJobPolicy";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative();
const importPreparation = z.union([
  McpChooseImportSchema,
  McpUploadedImportSchema,
  McpScanImportSchema,
  McpDiscoveredChapterScanSchema,
]);
export const MCP_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MCP_JOB_CAPACITY = 512;
export const mcpJobTargetSchema = z
  .object({
    chapterId: id,
    pageId: id,
    blockId: id.optional(),
    contextMode: z.enum(["none", "saved"]).optional(),
    revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
    requestId: z.string().uuid(),
  })
  .strict();
export type McpStoredJobTarget = z.infer<typeof mcpJobTargetSchema>;
export const mcpPersistedTargetSchema = z.union([
  mcpJobTargetSchema,
  McpContextResearchTargetSchema,
  McpExportPagesTargetSchema,
  McpExportZipTargetSchema,
  McpTypographyAnalysisTargetSchema,
  McpLetteringPrepareSchema,
  McpSelectionOcrSchema,
  McpSelectionTranslationSchema,
  McpSoundEffectPrepareSchema,
  importPreparation,
  McpImportCreateSchema,
  McpWorkFileCreateSchema,
  McpWorkFileExportTargetSchema,
  McpDiscoverChaptersSchema,
  McpImportBatchRunSchema,
  McpImportBatchPublishSchema,
  mcpExchangeJobTargetSchema,
  McpSyncOutputSchema,
]);
export const mcpJobResultMetadataSchema = z
  .object({
    outputSync: McpOutputSyncJobReferenceSchema.optional(),
    ...mcpExchangeResultFields,
    workFileExport: McpWorkFileExportMetadataSchema.optional(),
    workFileReceipt: McpWorkFileReceiptSchema.optional(),
    importBatch: McpImportBatchReferenceSchema.optional(),
    chapterDiscovery: McpChapterDiscoveryReferenceSchema.optional(),
    importPreview: McpImportPreviewReferenceSchema.optional(),
    importPreviewExpired: z.boolean().optional(),
    importReceipt: McpImportReceiptSchema.optional(),
    retainedContextProposal: retainedContextProposalSchema.optional(),
    exportPages: McpExportPagesMetadataSchema.optional(),
    retainedOutputId: z.string().uuid().optional(),
    sourceJobId: z.string().uuid().optional(),
    partialOutput: z.boolean().optional(),
    pageCount: count.optional(),
    status: z.string().max(40).optional(),
    revision: z.string().max(64).optional(),
    chapterId: id.optional(),
    pageId: id.optional(),
    blockId: id.optional(),
    engine: z.string().max(128).optional(),
    performed: z.array(z.string().max(40)).max(16).optional(),
    blockIds: z.array(id).max(5000).optional(),
    width: count.optional(),
    height: count.optional(),
    bytes: count.optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    kind: z.string().max(64).optional(),
    pagesChanged: count.optional(),
    blocksErased: count.optional(),
    blocksIncomplete: count.optional(),
    noTextDetected: z.boolean().optional(),
    effectReviewCandidates: count.optional(),
    needsReview: z.boolean().optional(),
    cleanupFailed: z.boolean().optional(),
    artifactExpired: z.boolean().optional(),
    observationExpired: z.boolean().optional(),
    blockOcr: McpBlockOcrObservationSchema.optional(),
    sourceSize: McpSourceSizeObservationSchema.optional(),
    typographyAnalysis: McpTypographyAnalysisObservationSchema.optional(),
    letteringPlan: McpLetteringPlanReferenceSchema.optional(),
    soundEffectPlan: McpSoundEffectPlanReferenceSchema.optional(),
    selectionAnalysis: McpSelectionAnalysisReferenceSchema.optional(),
    blockTranslation: McpBlockTranslationProposalSchema.optional(),
    proposalExpired: z.boolean().optional(),
    noSourceText: z.boolean().optional(),
    contextResearch: McpContextResearchResultSchema.optional(),
    queryCount: count.optional(),
    sourceCount: count.optional(),
    tavilyCreditsUsed: z.number().nonnegative().optional(),
  })
  .refine(validMcpExchangeResultMetadata, "Invalid exchange result metadata.")
  .refine(validMcpOutputSyncJobResult, "Invalid output sync result metadata.");
const jobSchema = z
  .object({
    id: z.string().uuid(),
    owner: id,
    requestId: id,
    kind: z.enum([
      "ocr",
      "blockOcr",
      "sourceSize",
      "typographyAnalysis",
      "letteringPrepare",
      "soundEffectPrepare",
      "selectionOcr",
      "selectionTranslation",
      "blockTranslation",
      "erase",
      "exportPng",
      "exportPages",
      "exportZip",
      "contextResearch",
      "importPrepare",
      "importCreate",
      "workFileImport",
      "workFileExport",
      "textFileExport",
      "contextFileExport",
      "textFileImport",
      "outputSync",
      "importDiscover",
      "importBatchScan",
      "importBatchCreate",
    ]),
    parameters: mcpPersistedTargetSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
    status: z.enum([
      "running",
      "completed",
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    progress: z
      .object({
        phase: z.string().max(128),
        completed: count.optional(),
        total: count.optional(),
      })
      .strict(),
    result: mcpJobResultMetadataSchema.optional(),
    error: z
      .object({ code: z.string().max(128), message: z.string().max(1024) })
      .strict()
      .optional(),
    startedAt: timestamp,
    finishedAt: timestamp.optional(),
    cancellationRequested: z.boolean(),
  })
  .strict();
export type McpStoredJob = z.infer<typeof jobSchema>;
export type McpJobPersistence = {
  load: () => Promise<unknown | null>;
  save: (snapshot: unknown) => Promise<void>;
};
const journalSchema = z
  .object({
    version: z.literal(1),
    records: z.array(jobSchema).max(MCP_JOB_CAPACITY),
  })
  .strict();

/** Dynamic availability is computed on reads; expired proposals are never advertised as usable. */
export function publicMcpJobResult(
  value: unknown,
  now: number,
): z.infer<typeof mcpJobResultMetadataSchema> | undefined {
  const result = mcpJobResultMetadataSchema.safeParse(
    mcpExchangeMetadataInput(value),
  ).data;
  if (!result) return undefined;
  if (result.sourceSize && result.sourceSize.expiresAt <= now) {
    const { sourceSize: _sourceSize, ...metadata } = result;
    return { ...metadata, sourceSize: undefined, observationExpired: true };
  }
  if (result.typographyAnalysis && result.typographyAnalysis.expiresAt <= now) {
    const { typographyAnalysis: _analysis, ...metadata } = result;
    return { ...metadata, observationExpired: true };
  }
  if (result.selectionAnalysis && result.selectionAnalysis.expiresAt <= now) {
    const { selectionAnalysis: _selection, ...metadata } = result;
    return { ...metadata, observationExpired: true };
  }
  const plan = expiredPlanResult(result, now);
  if (plan) return plan;
  if (result.contextResearch && result.contextResearch.expiresAt <= now)
    return { ...result, proposalExpired: true };
  return result;
}
/** Only public receipts/targets survive restart, never session evidence or capability URLs. */
export function persistedMcpJobResult(
  result: Record<string, unknown> | undefined,
) {
  if (result === undefined) return undefined;
  const {
    blockOcr,
    sourceSize,
    typographyAnalysis,
    letteringPlan,
    soundEffectPlan,
    selectionAnalysis,
    blockTranslation,
    contextResearch,
    importPreview,
    ...metadata
  } = mcpJobResultMetadataSchema.parse(mcpExchangeMetadataInput(result));
  const research = persistedResearchMetadata(
    contextResearch,
    metadata.retainedContextProposal,
  );
  return {
    ...metadata,
    ...research.fields,
    ...(importPreview ? { importPreviewExpired: true } : {}),
    ...(blockOcr || sourceSize || typographyAnalysis || selectionAnalysis
      ? { observationExpired: true }
      : {}),
    ...(blockTranslation ||
    research.sessionExpired ||
    letteringPlan ||
    soundEffectPlan
      ? { proposalExpired: true }
      : {}),
  };
}
export function parseMcpJobJournal(value: unknown): McpStoredJob[] {
  const parsed = journalSchema.parse(value);
  const ids = new Set<string>(),
    requests = new Set<string>();
  for (const record of parsed.records) {
    const key = JSON.stringify([record.owner, record.requestId]);
    if (
      ids.has(record.id) ||
      requests.has(key) ||
      record.fingerprint !==
        hashStableValue([record.kind, record.parameters]) ||
      !validJobTarget(record) ||
      !validMcpJobReferences(record) ||
      record.requestId !== record.parameters.requestId ||
      (record.status === "running") !== (record.finishedAt === undefined)
    )
      throw new Error("Invalid duplicate or inconsistent MCP job journal.");
    ids.add(record.id);
    requests.add(key);
  }
  return parsed.records;
}
function validJobTarget(record: McpStoredJob): boolean {
  const targets: Partial<Record<McpStoredJob["kind"], z.ZodType>> = {
    ...mcpExchangeJobTargets,
    outputSync: McpSyncOutputSchema,
    workFileExport: McpWorkFileExportTargetSchema,
    workFileImport: McpWorkFileCreateSchema,
    importBatchCreate: McpImportBatchPublishSchema,
    importBatchScan: McpImportBatchRunSchema,
    importDiscover: McpDiscoverChaptersSchema,
    importPrepare: importPreparation,
    importCreate: McpImportCreateSchema,
    soundEffectPrepare: McpSoundEffectPrepareSchema,
    selectionOcr: McpSelectionOcrSchema,
    selectionTranslation: McpSelectionTranslationSchema,
    letteringPrepare: McpLetteringPrepareSchema,
    typographyAnalysis: McpTypographyAnalysisTargetSchema,
    exportPages: McpExportPagesTargetSchema,
    exportZip: McpExportZipTargetSchema,
    contextResearch: McpContextResearchTargetSchema,
  };
  const target = targets[record.kind];
  return target
    ? target.safeParse(record.parameters).success
    : validPageTarget(record);
}
function validPageTarget(record: McpStoredJob): boolean {
  const parsed = mcpJobTargetSchema.safeParse(record.parameters);
  if (!parsed.success) return false;
  const target = parsed.data;
  const blockRequired = ["blockOcr", "blockTranslation"].includes(record.kind);
  return (
    (!blockRequired || Boolean(target.blockId)) &&
    (blockRequired ||
      record.kind === "erase" ||
      target.blockId === undefined) &&
    (record.kind === "blockTranslation" || target.contextMode === undefined)
  );
}
function expiredPlanResult(
  result: z.infer<typeof mcpJobResultMetadataSchema>,
  now: number,
) {
  if (result.importPreview && result.importPreview.expiresAt <= now) {
    const { importPreview: _preview, ...metadata } = result;
    return { ...metadata, importPreviewExpired: true };
  }
  if (
    result.retainedContextProposal &&
    result.retainedContextProposal.expiresAt <= now
  )
    return { ...result, proposalExpired: true };
  if (result.soundEffectPlan && result.soundEffectPlan.expiresAt <= now) {
    const { soundEffectPlan: _sound, ...metadata } = result;
    return { ...metadata, proposalExpired: true };
  }
  if (result.letteringPlan && result.letteringPlan.expiresAt <= now) {
    const { letteringPlan: _lettering, ...metadata } = result;
    return { ...metadata, proposalExpired: true };
  }
  return undefined;
}
