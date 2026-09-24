import { z } from "zod/v4";
import {
  McpResearchBatchPrepareSchema,
  McpResearchBatchAttemptSchema,
  McpResearchWorkSchema,
  mcpResearchBatchOutputs,
  type McpResearchWork,
} from "../../shared/mcpResearchBatch";
import { hashStableValue } from "../../shared/blockFingerprint";
import { McpEditError } from "./mcpEditPolicy";

const publicView = mcpResearchBatchOutputs.carrot_get_research_batch;
const hash = z.string().regex(/^[a-f0-9]{16}$/);
const row = z
  .object({
    target: McpResearchWorkSchema,
    status: publicView.shape.works.element.shape.status,
    attempts: z.array(McpResearchBatchAttemptSchema).max(30),
  })
  .strict();
const record = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    owner: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    version: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    input: McpResearchBatchPrepareSchema,
    inputFingerprint: hash,
    settingsFingerprint: hash,
    status: publicView.shape.status,
    errorCode: publicView.shape.errorCode.default(null),
    works: z.array(row).min(1).max(10),
    requests: z
      .array(z.object({ requestId: z.uuid(), fingerprint: hash }).strict())
      .max(64),
  })
  .strict();
export type McpResearchBatchRecord = z.infer<typeof record>;
export type McpResearchBatchRow = z.infer<typeof row>;
export const McpResearchBatchRecordSchema = record.superRefine((value, ctx) => {
  const attempts = value.works.flatMap((work) => work.attempts);
  if (
    value.expiresAt <= value.createdAt ||
    value.inputFingerprint !== hashStableValue(value.input) ||
    value.works.length !== value.input.works.length ||
    attempts.length > value.input.maxAttempts ||
    new Set(attempts.map((attempt) => attempt.requestId)).size !==
      attempts.length ||
    new Set(value.requests.map((request) => request.requestId)).size !==
      value.requests.length ||
    !value.works.every((work, index) =>
      validRow(work, value.input.works[index]),
    ) ||
    (value.status === "completed" && !value.works.every(researchWorkComplete))
  )
    ctx.addIssue({
      code: "custom",
      message: "Inconsistent multi-work research checkpoint.",
    });
});

function validRow(work: McpResearchBatchRow, original: McpResearchWork) {
  if (!original) return false;
  const fixed = [
    "workId",
    "chapterId",
    "revision",
    "referenceSnapshot",
    "engine",
  ] as const;
  if (fixed.some((key) => original[key] !== work.target[key])) return false;
  const last = work.attempts.at(-1);
  if (!last)
    return (
      work.status === (researchHolds(work.target).length ? "held" : "pending")
    );
  if (researchHolds(work.target).length || work.status !== last.status)
    return false;
  return (
    work.attempts.every(validAttempt) &&
    work.attempts
      .slice(0, -1)
      .every(
        (attempt) =>
          attempt.status === "failed" || attempt.status === "interrupted",
      )
  );
}
function validAttempt(attempt: z.infer<typeof McpResearchBatchAttemptSchema>) {
  if (attempt.status === "proposed")
    return !!attempt.proposalId && !!attempt.usage;
  return (
    !attempt.proposalId && (attempt.status !== "no_changes" || !!attempt.usage)
  );
}
export function researchHolds(work: McpResearchWork) {
  const holds: Array<"title_unconfirmed" | "spoiler_scope"> = [];
  if (!work.titleConfirmed) holds.push("title_unconfirmed");
  if (!work.allowSpoilers) holds.push("spoiler_scope");
  return holds;
}
export function researchWorkComplete(work: McpResearchBatchRow) {
  return work.status === "proposed" || work.status === "no_changes";
}
export function researchBatchView(
  value: McpResearchBatchRecord,
  active?: { pause: boolean; controller: AbortController },
) {
  const attempts = value.works.flatMap((work) => work.attempts);
  const usage = attempts.reduce(
    (sum, attempt) => ({
      queryCount: sum.queryCount + (attempt.usage?.queryCount ?? 0),
      sourceCount: sum.sourceCount + (attempt.usage?.sourceCount ?? 0),
      tavilyCreditsUsed:
        sum.tavilyCreditsUsed + (attempt.usage?.tavilyCreditsUsed ?? 0),
    }),
    { queryCount: 0, sourceCount: 0, tavilyCreditsUsed: 0 },
  );
  return publicView.parse({
    id: value.id,
    version: value.version,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    status: active
      ? "running"
      : value.status === "running"
        ? "interrupted"
        : value.status,
    errorCode: value.errorCode,
    pauseRequested: active?.pause ?? false,
    cancellationRequested: active?.controller.signal.aborted ?? false,
    maxAttempts: value.input.maxAttempts,
    attemptsUsed: attempts.length,
    usage,
    unknownUsageAttempts: attempts.filter((attempt) => !attempt.usage).length,
    works: value.works.map((work) => ({
      workId: work.target.workId,
      chapterId: work.target.chapterId,
      researchTitle: work.target.researchTitle,
      engine: work.target.engine,
      status:
        work.status === "running" && !active ? "interrupted" : work.status,
      holds: researchHolds(work.target),
      attempts: work.attempts,
    })),
    retention: "seven-days; same-profile-and-owner; no-automatic-reexecution",
    warnings: [
      "research_is_not_page_memory; no_context_is_applied_automatically",
      "confirmed_titles_are_caller_reviewed_not_automatically_identified",
      "spoiler_limited_work_is_held; existing_engine_reads_the_whole_saved_work",
      "attempt_budget_is_not_a_token_or_currency_budget; native_engine_limits_still_apply",
      "proposal_ids_require_owned_unexpired_lookup; unavailable_reviews_are_not_researched_again",
      "unknown_usage_is_not_zero_cost; interrupted_attempts_require_explicit_retry",
    ],
  });
}
export function assertResearchBatchVersion(
  value: McpResearchBatchRecord,
  version: number,
) {
  if (value.version !== version)
    throw new McpEditError(
      "revision_conflict",
      "Research plan changed; read its current version.",
    );
}
export function rememberResearchAction(
  value: McpResearchBatchRecord,
  requestId: string,
  fingerprint: string,
) {
  const previous = value.requests.find((item) => item.requestId === requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new McpEditError(
        "invalid_edit",
        "Research requestId belongs to another action.",
      );
    return true;
  }
  if (value.requests.length >= 64)
    throw new McpEditError(
      "invalid_edit",
      "Research action history is full; prepare a remaining-work plan.",
    );
  value.requests.push({ requestId, fingerprint });
  return false;
}
