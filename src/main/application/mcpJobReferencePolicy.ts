import {
  McpWorkFileCreateSchema,
  matchesWorkFileReceipt,
  type McpWorkFileReceipt,
} from "../../shared/mcpWorkFileImport";
import { McpImportBatchRunSchema } from "../../shared/mcpImportBatch";
import { McpWorkFileExportTargetSchema } from "../../shared/mcpWorkFileExport";
import { z } from "zod/v4";
import {
  McpContextResearchTargetSchema,
  McpContextResearchResultSchema,
} from "../../shared/mcpContextEditing";
import {
  McpImportPublicationSchema,
  matchesImportPublication,
} from "../../shared/mcpImportPublication";
import { McpDiscoverChaptersSchema } from "../../shared/mcpChapterDiscovery";
import type { McpImportReceipt } from "../../shared/mcpLibraryImport";
import { validMcpExchangeJobReferences } from "./mcpExchangeJobPolicy";
import { validMcpOutputSyncJobReference } from "./mcpOutputSyncJobPolicy";

type JobReferenceInput = {
  id?: string;
  kind: string;
  requestId: string;
  parameters: unknown;
  result?: {
    workFileReceipt?: McpWorkFileReceipt;
    workFileExport?: {
      workId: string;
      chapterIds: string[];
      snapshot: string;
      sourceSnapshot: string;
    };
    retainedContextProposal?: { chapterId: string };
    importReceipt?: McpImportReceipt;
    importBatch?: { id: string; version: number };
    chapterDiscovery?: { requestId: string; linkCount: number };
  };
};
/** A retained ID alone cannot authorize a result belonging to a different command. */
export function validMcpJobReferences(record: JobReferenceInput): boolean {
  return (
    validMcpOutputSyncJobReference(record) &&
    validMcpExchangeJobReferences(record) &&
    validWorkFileReference(record) &&
    validWorkFileExportReference(record) &&
    validResearchReference(record) &&
    validImportReference(record) &&
    validDiscoveryReference(record) &&
    validImportBatchReference(record)
  );
}
function validWorkFileExportReference(record: JobReferenceInput): boolean {
  const reference = record.result?.workFileExport;
  if (!reference) return true;
  const input = McpWorkFileExportTargetSchema.safeParse(record.parameters);
  return (
    record.kind === "workFileExport" &&
    input.success &&
    input.data.workId === reference.workId &&
    input.data.snapshot === reference.snapshot &&
    input.data.sourceSnapshot === reference.sourceSnapshot &&
    input.data.chapterIds.length === reference.chapterIds.length &&
    input.data.chapterIds.every(
      (id, index) => id === reference.chapterIds[index],
    )
  );
}
function validWorkFileReference(record: JobReferenceInput): boolean {
  const reference = record.result?.workFileReceipt;
  if (!reference) return true;
  const input = McpWorkFileCreateSchema.safeParse(record.parameters);
  return (
    record.kind === "workFileImport" &&
    input.success &&
    record.requestId === reference.requestId &&
    matchesWorkFileReceipt(input.data, reference)
  );
}
function validResearchReference(record: JobReferenceInput): boolean {
  const reference = record.result?.retainedContextProposal;
  if (!reference) return true;
  const target = McpContextResearchTargetSchema.safeParse(record.parameters);
  return (
    record.kind === "contextResearch" &&
    target.success &&
    target.data.chapterId === reference.chapterId
  );
}
function validImportReference(record: JobReferenceInput): boolean {
  const reference = record.result?.importReceipt;
  if (!reference) return true;
  const target = McpImportPublicationSchema.safeParse(record.parameters);
  if (!target.success || reference.requestId !== record.requestId) return false;
  const expected =
    "items" in target.data ? "importBatchCreate" : "importCreate";
  return (
    record.kind === expected && matchesImportPublication(target.data, reference)
  );
}
function validDiscoveryReference(record: JobReferenceInput): boolean {
  const reference = record.result?.chapterDiscovery;
  if (!reference) return true;
  const input = McpDiscoverChaptersSchema.safeParse(record.parameters);
  return (
    record.kind === "importDiscover" &&
    input.success &&
    reference.requestId === record.requestId &&
    reference.linkCount <= input.data.maxLinks
  );
}
function validImportBatchReference(record: JobReferenceInput): boolean {
  const reference = record.result?.importBatch;
  if (!reference) return true;
  const input = McpImportBatchRunSchema.safeParse(record.parameters);
  return (
    record.kind === "importBatchScan" &&
    input.success &&
    input.data.id === reference.id &&
    reference.version > input.data.version
  );
}

export const retainedContextProposalSchema =
  McpContextResearchResultSchema.pick({
    proposalId: true,
    chapterId: true,
    workId: true,
    expiresAt: true,
  })
    .extend({
      retention: z.literal("seven-days"),
      availability: z.literal("lookup-required"),
    })
    .strict();

/** A stable ID is a lookup hint; disk presence, owner and expiry still need checking. */
function retainedResearchReference(
  research: z.infer<typeof McpContextResearchResultSchema> | undefined,
) {
  if (
    research?.retention !== "seven-days" ||
    research.source !== "app-research"
  )
    return undefined;
  return retainedContextProposalSchema.parse({
    proposalId: research.proposalId,
    chapterId: research.chapterId,
    workId: research.workId,
    expiresAt: research.expiresAt,
    retention: "seven-days",
    availability: "lookup-required",
  });
}
export function persistedResearchMetadata(
  value: z.infer<typeof McpContextResearchResultSchema> | undefined,
  previous: z.infer<typeof retainedContextProposalSchema> | undefined,
) {
  const newlyRetained = retainedResearchReference(value);
  const reference = newlyRetained ?? previous;
  return {
    sessionExpired: Boolean(value && !newlyRetained),
    fields: {
      ...(reference ? { retainedContextProposal: reference } : {}),
      ...(value
        ? {
            queryCount: value.queryCount,
            sourceCount: value.sourceCount,
            tavilyCreditsUsed: value.tavilyCreditsUsed,
          }
        : {}),
    },
  };
}
