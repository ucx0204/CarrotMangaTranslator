import type { McpCompositeGuard } from "./mcpCompositeWorkflowPorts";
import { randomUUID } from "node:crypto";
import {
  McpCompositeBindSchema,
  McpCompositeMutationSchema,
  McpCompositePrepareSchema,
} from "../../shared/mcpCompositeWorkflow";
import type {
  McpCompositeBind,
  McpCompositePrepare,
} from "../../shared/mcpCompositeWorkflow";
import { McpCompositeReviewReportSchema } from "../../shared/mcpCompositeWorkflowReview";
import type {
  McpCompositeBinding,
  McpCompositeNative,
  McpCompositeRecord,
  McpCompositeRepository,
} from "./mcpCompositeWorkflowPorts";
import {
  assertCompositeBinding,
  assertCompositePages,
  compositeError,
  compositeFingerprint,
  nextCompositePhase,
  rememberCompositeAction,
  savedCompositeBinding,
  zeroCompositeCost,
} from "./mcpCompositeWorkflowPolicy";
import { parseCompositeRecord } from "./mcpCompositeWorkflowRecord";
import {
  completeCompositeOutcome,
  saveCompositeRecord,
} from "./mcpCompositeWorkflowExecution";
import {
  assertCompositeCorrection,
  acceptCompositeReport,
} from "./mcpCompositeWorkflowReviewPolicy";
import {
  McpCompositePhaseRunner,
  type McpCompositeExecutionHooks,
} from "./mcpCompositePhaseRunner";

/** Bounded phase controller only. Native services retain models, queues, locks and receipts. */
export class McpCompositeWorkflowService {
  private admitting = false;
  private stopped = false;
  private admissionDone = Promise.resolve();
  private readonly bindings = new Map<string, McpCompositeBinding>();
  private readonly runner: McpCompositePhaseRunner;
  constructor(
    private readonly repository: McpCompositeRepository,
    private readonly native: McpCompositeNative,
    admission?: McpCompositeExecutionHooks,
  ) {
    this.runner = new McpCompositePhaseRunner(repository, native, admission);
  }

  prepare(owner: string, input: McpCompositePrepare, guard: McpCompositeGuard) {
    guard = this.authorized(guard);
    return this.admit(async () => {
      const plan = McpCompositePrepareSchema.parse(input);
      guard();
      const existing = await this.repository.find(owner, plan.requestId);
      guard();
      if (existing) {
        if (existing.initialFingerprint !== compositeFingerprint(plan))
          compositeError(
            "Preparation request ID was reused with different input.",
          );
        return existing;
      }
      const snapshot = await this.native.prepare(owner, plan, guard);
      const targets = plan.targets.kind === "saved" ? plan.targets.pages : [];
      assertCompositePages(targets, snapshot.pages);
      const now = Date.now();
      const record: McpCompositeRecord = {
        format: 1,
        kind: "composite-workflow",
        id: randomUUID(),
        owner,
        version: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 7 * 24 * 60 * 60_000,
        plan,
        initialFingerprint: compositeFingerprint(plan),
        status: "prepared",
        snapshot,
        targets,
        phases: plan.phases.map(({ id }) => ({ id, status: "unbound" })),
        used: zeroCompositeCost(),
        usageUnknown: false,
        reviewPairs: [],
        actions: [],
      };
      guard();
      return this.repository.create(parseCompositeRecord(record), guard);
    });
  }
  bind(owner: string, input: McpCompositeBind, guard: McpCompositeGuard) {
    guard = this.authorized(guard);
    return this.admit(async () => {
      const parsed = McpCompositeBindSchema.parse(input);
      const record = await this.load(owner, parsed.id, guard);
      if (!rememberCompositeAction(record, parsed.requestId, ["bind", parsed]))
        return record;
      this.version(record, parsed.version);
      this.mutable(record);
      const phase = nextCompositePhase(record);
      if (!phase || phase.attemptId)
        compositeError(
          "An admitted phase cannot be rebound or retried; reconcile its exact receipt.",
        );
      assertCompositeCorrection(record, phase.id);
      const binding = await this.native.resolve(record, parsed, guard);
      assertCompositeBinding(record, parsed, binding);
      guard();
      phase.binding = savedCompositeBinding(binding);
      phase.status = "bound";
      const saved = await saveCompositeRecord(this.repository, record, guard);
      this.bindings.set(this.key(record.id, phase.id), binding);
      return saved;
    });
  }
  run(owner: string, input: unknown, guard: McpCompositeGuard) {
    guard = this.authorized(guard);
    return this.admit(async () => {
      const parsed = McpCompositeMutationSchema.parse(input);
      const record = await this.load(owner, parsed.id, guard);
      if (!rememberCompositeAction(record, parsed.requestId, ["run", parsed]))
        return record;
      this.version(record, parsed.version);
      this.mutable(record);
      this.runner.assertAvailable();
      const phase = nextCompositePhase(record);
      if (!phase) compositeError("All phases are already completed.");
      const key = this.key(record.id, phase.id);
      const saved = await this.runner.run(
        record,
        phase.id,
        parsed.requestId,
        guard,
        this.bindings.get(key),
      );
      this.bindings.delete(key);
      return saved;
    });
  }
  report(owner: string, input: unknown, guard: McpCompositeGuard) {
    guard = this.authorized(guard);
    return this.admit(async () => {
      const parsed = McpCompositeReviewReportSchema.parse(input);
      const record = await this.load(owner, parsed.id, guard);
      if (
        !rememberCompositeAction(record, parsed.requestId, ["report", parsed])
      )
        return record;
      this.version(record, parsed.version);
      if (record.status !== "awaiting-review")
        compositeError("The parent is not awaiting host review.");
      const phase = nextCompositePhase(record);
      if (!phase?.evidence)
        compositeError("Actual rendered review evidence is unavailable.");
      await this.native.verifyEvidence(record, phase.evidence, guard);
      await this.native.verifyReviewReport(record, parsed, guard);
      guard();
      acceptCompositeReport(record, parsed);
      if (record.stopReason === undefined)
        record.status = nextCompositePhase(record) ? "prepared" : "completed";
      return saveCompositeRecord(this.repository, record, guard);
    });
  }
  reconcile(owner: string, input: unknown, guard: McpCompositeGuard) {
    guard = this.authorized(guard);
    return this.admit(async () => {
      const parsed = McpCompositeMutationSchema.parse(input);
      const record = await this.load(owner, parsed.id, guard);
      if (
        !rememberCompositeAction(record, parsed.requestId, [
          "reconcile",
          parsed,
        ])
      )
        return record;
      this.version(record, parsed.version);
      if (this.runner.owned(owner, record.id))
        compositeError(
          "Wait for the owned child to settle before reconciliation.",
        );
      const phase = nextCompositePhase(record);
      if (!phase?.attemptId || !phase.binding)
        compositeError(
          "No exact native attempt is available for reconciliation.",
        );
      const outcome = await this.native.reconcile(
        phase.binding,
        phase.child,
        guard,
      );
      if (!outcome) {
        record.status = "held";
        record.stopReason = "interrupted";
        record.usageUnknown = true;
        phase.status = "held";
        return saveCompositeRecord(this.repository, record, guard);
      }
      return completeCompositeOutcome(
        this.native,
        this.repository,
        record,
        outcome,
        guard,
      );
    });
  }
  async get(owner: string, id: string, guard: McpCompositeGuard) {
    const record = await this.load(owner, id, guard);
    return this.observe(record);
  }
  /** Native composition supplies an already owned retained record; this does not load or execute anything. */
  observe(value: McpCompositeRecord) {
    const record = structuredClone(value);
    const active = this.runner.owned(record.owner, record.id);
    const phase = nextCompositePhase(record);
    if (
      active?.started &&
      record.status === "held" &&
      record.stopReason === "native-outcome" &&
      phase?.outcome?.status === "completed"
    ) {
      // The durable receipt checkpoint remains held until refresh commits.
      record.status = "running";
      phase.status = "running";
      delete record.stopReason;
    } else if (record.status === "running" && !active) {
      record.status = "held";
      record.stopReason = "interrupted";
      if (phase?.status === "running") phase.status = "held";
    }
    return record;
  }
  async waitForCompletion(owner: string, id: string, guard: McpCompositeGuard) {
    await this.load(owner, id, guard);
    await this.runner.owned(owner, id)?.done;
    return this.get(owner, id, guard);
  }
  async control(
    owner: string,
    input: unknown,
    direction: "pause" | "cancel",
    guard: McpCompositeGuard,
  ) {
    const parsed = McpCompositeMutationSchema.parse(input);
    const record = await this.load(owner, parsed.id, guard);
    if (!rememberCompositeAction(record, parsed.requestId, [direction, parsed]))
      return record;
    this.version(record, parsed.version);
    return this.runner.control(record, direction, guard);
  }
  stop() {
    this.stopped = true;
    this.runner.stop();
  }
  async close() {
    this.stop();
    const results = await Promise.allSettled([
      this.admissionDone,
      ...this.runner.settlementPromises(),
    ]);
    this.bindings.clear();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        "Composite admission or native cleanup could not settle.",
        { cause: errors[0] },
      );
  }

  private async load(owner: string, id: string, guard: McpCompositeGuard) {
    guard();
    const record = parseCompositeRecord(await this.repository.load(owner, id));
    if (record.owner !== owner)
      compositeError("Composite workflow is not owned by this connection.");
    guard();
    return structuredClone(record);
  }
  private async admit<T>(execute: () => Promise<T>) {
    if (this.stopped || this.admitting)
      compositeError(
        "Composite admission is unavailable or already in progress.",
      );
    this.admitting = true;
    let finish!: () => void;
    this.admissionDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      return await execute();
    } finally {
      this.admitting = false;
      finish();
    }
  }
  private authorized(guard: McpCompositeGuard): McpCompositeGuard {
    return (scopes) => {
      if (this.stopped) compositeError("Composite admissions are stopped.");
      guard(scopes);
    };
  }
  private mutable(record: McpCompositeRecord) {
    if (record.status !== "prepared" && record.status !== "paused")
      compositeError("The parent is not ready for another bound phase.");
  }
  private version(record: McpCompositeRecord, expected: number) {
    if (record.version !== expected)
      compositeError(
        "The composite version changed. Read the parent before mutating it.",
      );
  }
  private key(id: string, phase: string) {
    return `${id}/${phase}`;
  }
}
