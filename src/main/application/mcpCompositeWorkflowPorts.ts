import type {
  McpCompositeBind,
  McpCompositeBudget,
  McpCompositeChildReference,
  McpCompositePage,
  McpCompositePrepare,
} from "../../shared/mcpCompositeWorkflow";
import type { McpCompositeWorkflowAction } from "../../shared/mcpCompositeWorkflowActions";
import type {
  McpCompositeRenderEvidence,
  McpCompositeReviewReport,
} from "../../shared/mcpCompositeWorkflowReview";

export type McpCompositeGuard = (scopes?: readonly string[]) => void;
export type McpCompositeCost = McpCompositeBudget & {
  pageEdits: Array<{ chapterId: string; pageId: string; edits: number }>;
};
export type McpCompositeSnapshot = {
  fingerprint: string;
  /** Stable authorized settings/provider/paid-processing policy; refresh cannot enlarge it. */
  policyFingerprint: string;
  pages: Array<
    McpCompositePage & {
      revision: string;
      reviewRevision: string;
      sourceFingerprint: string;
      /** Private native evidence separating chapter structure and memory from editable page state. */
      membershipFingerprint: string;
      memoryFingerprint: string;
      contextFingerprint: string;
      settingsFingerprint: string;
      fontFingerprint: string;
    }
  >;
};
export type McpCompositeSavedBinding = {
  owner: string;
  compositeId: string;
  phaseId: string;
  family: McpCompositeWorkflowAction["kind"];
  inputFingerprint: string;
  /** Native journal reference, server derived; null means no safe durable reconciliation proof. */
  nativeReference: {
    requestId: string;
    kind: string;
    fingerprint: string;
  } | null;
  /** Equals action.input.requestId. Family + request ID bind exact replay/reconciliation. */
  nativeRequestId: string;
  snapshot: McpCompositeSnapshot;
  predecessorReceipts: McpCompositeChildReference[];
  cost: McpCompositeCost;
};
export type McpCompositeBinding = McpCompositeSavedBinding & {
  action: McpCompositeWorkflowAction;
};
export type McpCompositeOutcome = {
  status: "completed" | "partial" | "failed" | "cancelled" | "interrupted";
  receipt: McpCompositeChildReference;
  resultFingerprint: string;
  /** Only native import receipts may populate an exact reviewed-item mapping. */
  imported?: {
    selectionFingerprint: string;
    items: Array<{ itemKey: string; page: McpCompositePage }>;
  };
};
export type McpCompositePhaseState = {
  id: string;
  status:
    | "unbound"
    | "bound"
    | "running"
    | "awaiting-review"
    | "completed"
    | "skipped"
    | "held";
  binding?: McpCompositeSavedBinding;
  attemptId?: string;
  child?: McpCompositeChildReference;
  outcome?: McpCompositeOutcome;
  evidence?: McpCompositeRenderEvidence[];
  report?: McpCompositeReviewReport;
};
export type McpCompositeRecord = {
  format: 1;
  kind: "composite-workflow";
  id: string;
  owner: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  plan: McpCompositePrepare;
  initialFingerprint: string;
  status:
    | "prepared"
    | "running"
    | "awaiting-review"
    | "paused"
    | "held"
    | "completed"
    | "cancelled";
  stopReason?:
    | "native-outcome"
    | "checkpoint-failed"
    | "interrupted"
    | "no-progress"
    | "oscillation"
    | "review-blocked"
    | "budget";
  snapshot: McpCompositeSnapshot;
  targets: McpCompositePage[];
  phases: McpCompositePhaseState[];
  used: McpCompositeCost;
  usageUnknown: boolean;
  reviewPairs: string[];
  actions: Array<{ requestId: string; fingerprint: string }>;
};
export interface McpCompositeSettlement {
  /** Exact reserved attempt only; valid for late cleanup after authority is revoked. */
  checkpointChild(
    receipt: McpCompositeChildReference,
  ): Promise<McpCompositeRecord>;
  finish(outcome: McpCompositeOutcome): Promise<McpCompositeRecord>;
  hold(
    reason: "interrupted" | "checkpoint-failed",
  ): Promise<McpCompositeRecord>;
}
export interface McpCompositeRepository {
  load(owner: string, id: string): Promise<McpCompositeRecord>;
  find(owner: string, requestId: string): Promise<McpCompositeRecord | null>;
  create(
    record: McpCompositeRecord,
    guard: McpCompositeGuard,
  ): Promise<McpCompositeRecord>;
  /** Caller supplies version=expectedVersion+1; same-owner CAS and commit guard. */
  save(
    record: McpCompositeRecord,
    expectedVersion: number,
    guard: McpCompositeGuard,
  ): Promise<McpCompositeRecord>;
  /** Durable budget/attempt reservation precedes any native admission. */
  reserve(
    record: McpCompositeRecord,
    expectedVersion: number,
    guard: McpCompositeGuard,
  ): Promise<{
    record: McpCompositeRecord;
    settlement: McpCompositeSettlement;
  }>;
}
export interface McpCompositeNative {
  /** Preparation reads only; no model, import, render, edit, job or lease admission. */
  prepare(
    owner: string,
    plan: McpCompositePrepare,
    guard: McpCompositeGuard,
  ): Promise<McpCompositeSnapshot>;
  resolve(
    record: McpCompositeRecord,
    input: McpCompositeBind,
    guard: McpCompositeGuard,
  ): Promise<McpCompositeBinding>;
  verify(binding: McpCompositeBinding, guard: McpCompositeGuard): Promise<void>;
  /** Exactly one native admission. Must settle physical cleanup before resolving OR rejecting,
   * including an onReceipt failure, revoked authorization, abort, and late native errors. */
  execute(
    binding: McpCompositeBinding,
    signal: AbortSignal,
    onReceipt: (receipt: McpCompositeChildReference) => Promise<void>,
    guard: McpCompositeGuard,
  ): Promise<McpCompositeOutcome>;
  control(
    binding: McpCompositeSavedBinding,
    receipt: McpCompositeChildReference,
    direction: "pause" | "cancel",
    guard: McpCompositeGuard,
  ): Promise<void>;
  /** Exact family/request lookup; never starts work or substitutes latest child state. */
  reconcile(
    binding: McpCompositeSavedBinding,
    receipt: McpCompositeChildReference | undefined,
    guard: McpCompositeGuard,
  ): Promise<McpCompositeOutcome | null>;
  refresh(
    record: McpCompositeRecord,
    outcome: McpCompositeOutcome,
    guard: McpCompositeGuard,
  ): Promise<McpCompositeSnapshot>;
  /** Uses actual saved rendered PNG and repeats source/settings/font checks before publication. */
  renderEvidence(
    record: McpCompositeRecord,
    phaseId: string,
    pass: number,
    signal: AbortSignal,
    guard: McpCompositeGuard,
  ): Promise<McpCompositeRenderEvidence[]>;
  verifyReviewReport(
    record: McpCompositeRecord,
    report: McpCompositeReviewReport,
    guard: McpCompositeGuard,
  ): Promise<void>;
  /** Rechecks issued evidence against current native sources, not host supplied digests. */
  verifyEvidence(
    record: McpCompositeRecord,
    evidence: McpCompositeRenderEvidence[],
    guard: McpCompositeGuard,
  ): Promise<void>;
}
