import type { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpContextResearchTargetSchema,
  mcpContextRevision,
} from "../../shared/mcpContextEditing";
import {
  McpResearchBatchUsageSchema,
  type McpResearchBatchAttemptSchema,
  type McpResearchBatchPrepare,
  type McpResearchBatchRun,
  type McpResearchWork,
} from "../../shared/mcpResearchBatch";
import type {
  McpResearchBatchRecord,
  McpResearchBatchRow,
} from "../application/mcpResearchBatchPolicy";
import { contextMigrationSnapshot } from "../application/mcpContextMigrationPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpOperationService } from "../application/mcpOperationService";
import type { InpaintingJobContext } from "../jobs/inpaintingJobTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import {
  readWorkContextReferences,
  readWorkContextReferencesUnlocked,
} from "../library/libraryContextEditingFacade";
import { withLibraryRead } from "../library/lock";
import { getAppSettings } from "../settingsStore";
import { withExecutionSettings } from "../settings/executionSettings";
import { assertModelCleanupComplete } from "../runtimeSupport/modelCleanupBarrier";
import type { createMcpContextResearchExecutor } from "./mcpContextResearchAdapter";
import { McpResearchProposalRepository } from "./mcpResearchProposalRepository";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

type Attempt = z.infer<typeof McpResearchBatchAttemptSchema>;
type Job = ReturnType<McpOperationService["status"]>;
type Options = {
  app: InpaintingJobContext;
  operations: McpOperationService;
  storage: McpRetentionStorage;
  execute: ReturnType<typeof createMcpContextResearchExecutor>;
  lifetime: AbortSignal;
};
export function createMcpResearchBatchRuntime(options: Options) {
  const repository = new McpResearchProposalRepository(
    options.storage,
    options.lifetime,
  );
  return {
    prepare: async (input: McpResearchBatchPrepare, guard: () => void) => {
      guard();
      const settings = hashStableValue(
        await getAppSettings(options.app.appPaths),
      );
      for (const work of input.works) await verifyResearchWork(work, guard);
      return {
        settings,
        verifyUnlocked: async () => {
          guard();
          if (
            hashStableValue(await getAppSettings(options.app.appPaths)) !==
            settings
          )
            throw new McpEditError(
              "revision_conflict",
              "Research settings changed during preparation.",
            );
          for (const work of input.works)
            await verifyResearchWork(
              work,
              guard,
              readWorkContextReferencesUnlocked,
            );
        },
      };
    },
    open: async (
      record: McpResearchBatchRecord,
      input: McpResearchBatchRun,
      guard: () => void,
    ) => {
      guard();
      const settings = await getAppSettings(options.app.appPaths);
      if (hashStableValue(settings) !== record.settingsFingerprint)
        throw new McpEditError(
          "revision_conflict",
          "Research settings changed; restore them or prepare a remaining-work plan.",
        );
      return {
        assertReady: () => {
          guard();
          assertModelCleanupComplete();
        },
        execute: (
          row: McpResearchBatchRow,
          attempt: Attempt,
          signal: AbortSignal,
          onJob: (id: string) => Promise<void>,
        ) =>
          executeResearchWork(
            options,
            record.owner,
            row,
            attempt,
            settings,
            input,
            signal,
            onJob,
            guard,
          ),
        reconcile: (row: McpResearchBatchRow, attempt: Attempt) =>
          reconcileResearchWork(
            options,
            repository,
            record.owner,
            row,
            attempt,
            guard,
          ),
      };
    },
  };
}
async function verifyResearchWork(
  work: McpResearchWork,
  guard: () => void,
  read = readWorkContextReferences,
) {
  guard();
  const graph = await read(work.chapterId, guard);
  const anchor = graph.chapters.find(
    (item) => item.chapter.id === work.chapterId,
  );
  if (
    !anchor ||
    graph.workId !== work.workId ||
    mcpContextRevision({ ...graph, storyMemory: anchor.storyMemory }) !==
      work.revision ||
    contextMigrationSnapshot(graph, work.chapterId, guard).snapshot !==
      work.referenceSnapshot
  )
    throw new McpEditError(
      "revision_conflict",
      "A fixed research work or its saved evidence changed.",
    );
  guard();
}
function researchTarget(row: McpResearchBatchRow, attempt: Attempt) {
  return McpContextResearchTargetSchema.parse({
    chapterId: row.target.chapterId,
    revision: row.target.revision,
    researchTitle: row.target.researchTitle,
    engine: row.target.engine,
    requestId: attempt.requestId,
  });
}
async function executeResearchWork(
  options: Options,
  owner: string,
  row: McpResearchBatchRow,
  attempt: Attempt,
  settings: AppSettings,
  input: McpResearchBatchRun,
  signal: AbortSignal,
  onJob: (id: string) => Promise<void>,
  guard: () => void,
): Promise<Attempt> {
  let accepted: Job;
  const target = researchTarget(row, attempt);
  try {
    await verifyResearchWork(row.target, guard);
    if (
      row.target.engine === "tavily" &&
      settings.internetResearch.tavilyAnalysisProvider !== "api" &&
      !input.allowAssetDownloads
    )
      throw new McpEditError(
        "access_denied",
        "Local research analysis requires explicit asset preparation permission.",
      );
    guard();
    accepted = await options.operations.start({
      owner,
      requestId: attempt.requestId,
      kind: "contextResearch",
      parameters: target,
      assertAuthorized: guard,
      execute: (context) =>
        withExecutionSettings(settings, () =>
          options.execute(owner, target, context, row.target.referenceSnapshot),
        ),
    });
  } catch (error) {
    guard();
    return {
      ...attempt,
      status: "failed",
      errorCode:
        error instanceof McpEditError
          ? error.code
          : "research_admission_failed",
      usage: { queryCount: 0, sourceCount: 0, tavilyCreditsUsed: 0 },
    };
  }
  try {
    await onJob(accepted.jobId);
  } catch (error) {
    const abort = new AbortController();
    abort.abort();
    await options.operations.waitForCompletion(
      accepted.jobId,
      owner,
      abort.signal,
    );
    throw error;
  }
  const job = await options.operations.waitForCompletion(
    accepted.jobId,
    owner,
    signal,
  );
  return researchJobOutcome(row, attempt, job);
}
function researchJobOutcome(
  row: McpResearchBatchRow,
  attempt: Attempt,
  job: Job,
): Attempt {
  assertResearchReceipt(row, attempt, job);
  const usage = researchJobUsage(job);
  const success = successfulResearchOutcome(row, attempt, job, usage);
  if (success) return success;
  return {
    ...attempt,
    jobId: job.jobId,
    status: job.status === "interrupted" ? "interrupted" : "failed",
    usage,
    errorCode: job.error?.code ?? "research_result_unavailable",
  };
}
function assertResearchReceipt(
  row: McpResearchBatchRow,
  attempt: Attempt,
  job: Job,
) {
  const target = McpContextResearchTargetSchema.safeParse(job.target);
  if (
    !target.success ||
    job.kind !== "contextResearch" ||
    hashStableValue(target.data) !==
      hashStableValue(researchTarget(row, attempt))
  )
    throw new McpEditError(
      "invalid_edit",
      "Research child receipt belongs to another target.",
    );
  if (job.status === "running")
    throw new McpEditError(
      "editor_busy",
      "Research child has not completed native cleanup.",
    );
}
function researchJobUsage(job: Job): Attempt["usage"] {
  const source = job.result?.contextResearch ?? job.result;
  if (!source) return null;
  const { queryCount, sourceCount, tavilyCreditsUsed } = source;
  return (
    McpResearchBatchUsageSchema.safeParse({
      queryCount,
      sourceCount,
      tavilyCreditsUsed,
    }).data ?? null
  );
}
function successfulResearchOutcome(
  row: McpResearchBatchRow,
  attempt: Attempt,
  job: Job,
  usage: Attempt["usage"],
): Attempt | undefined {
  if (job.status !== "completed" || !usage) return undefined;
  const result = job.result;
  const proposal = result?.contextResearch ?? result?.retainedContextProposal;
  if (proposal) {
    if (
      proposal.chapterId !== row.target.chapterId ||
      proposal.workId !== row.target.workId
    )
      throw new McpEditError(
        "invalid_edit",
        "Research proposal target is inconsistent.",
      );
    return {
      ...attempt,
      jobId: job.jobId,
      status: "proposed",
      proposalId: proposal.proposalId,
      usage,
      errorCode: null,
    };
  }
  if (result?.status === "no_changes")
    return {
      ...attempt,
      jobId: job.jobId,
      status: "no_changes",
      usage,
      errorCode: null,
    };
  return undefined;
}
async function reconcileResearchWork(
  options: Options,
  repository: McpResearchProposalRepository,
  owner: string,
  row: McpResearchBatchRow,
  attempt: Attempt,
  guard: () => void,
): Promise<Attempt | undefined> {
  guard();
  await options.operations.ready();
  const job = options.operations
    .list(owner, 0, 512)
    .jobs.find((entry) => entry.requestId === attempt.requestId);
  if (job?.status === "running")
    throw new McpEditError(
      "editor_busy",
      "The previous research child is still running.",
    );
  const saved = await withLibraryRead(async () => {
    const entry = (await options.storage.index()).entries.find(
      (item) =>
        item.owner === owner &&
        item.kind === "research-proposal" &&
        item.requestId === attempt.requestId,
    );
    if (!entry) return undefined;
    const record = await repository.load(owner, entry.id);
    if (
      !record.research ||
      record.metadata.workId !== row.target.workId ||
      record.referenceSnapshot !== row.target.referenceSnapshot ||
      hashStableValue(record.research.target) !==
        hashStableValue(researchTarget(row, attempt))
    )
      throw new McpEditError(
        "invalid_edit",
        "Retained research belongs to another fixed work or attempt.",
      );
    return {
      ...attempt,
      status: "proposed" as const,
      proposalId: record.metadata.proposalId,
      usage: McpResearchBatchUsageSchema.parse({
        queryCount: record.research.queryCount,
        sourceCount: record.research.sourceCount,
        tavilyCreditsUsed: record.research.tavilyCreditsUsed,
      }),
      errorCode: null,
    };
  });
  guard();
  return saved ?? (job ? researchJobOutcome(row, attempt, job) : undefined);
}
