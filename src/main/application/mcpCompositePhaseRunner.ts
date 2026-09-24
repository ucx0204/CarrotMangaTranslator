import type {
  McpCompositeBinding,
  McpCompositeGuard,
  McpCompositeNative,
  McpCompositeRecord,
  McpCompositeRepository,
} from "./mcpCompositeWorkflowPorts";
import {
  compositeError,
  compositeFingerprint,
  nextCompositePhase,
  savedCompositeBinding,
} from "./mcpCompositeWorkflowPolicy";
import {
  executeCompositeAttempt,
  reserveCompositeAttempt,
  saveCompositeRecord,
} from "./mcpCompositeWorkflowExecution";
import { renderCompositeReview } from "./mcpCompositeWorkflowReviewRunner";
import { McpCompositeRunLifetime } from "./mcpCompositeRunLifetime";

export type McpCompositeExecutionHooks = {
  acquire: (record: McpCompositeRecord) => { release: () => void };
  reportError?: (error: unknown) => void;
};

/** Owns one phase's reservation, pending/active identity, controls and physical settlement. */
export class McpCompositePhaseRunner {
  private pending?: McpCompositeRunLifetime;
  private active?: McpCompositeRunLifetime;
  constructor(
    private readonly repository: McpCompositeRepository,
    private readonly native: McpCompositeNative,
    private readonly admission?: McpCompositeExecutionHooks,
  ) {}

  assertAvailable() {
    if (this.active)
      compositeError("Another composite child is still physically active.");
  }

  async run(
    record: McpCompositeRecord,
    phaseId: string,
    requestId: string,
    guard: McpCompositeGuard,
    binding: McpCompositeBinding | undefined,
  ) {
    const descriptor = record.plan.phases.find((item) => item.id === phaseId);
    const lease = this.admission?.acquire(record);
    const lifetime = new McpCompositeRunLifetime(
      record,
      () => lease?.release(),
      this.admission?.reportError,
    );
    this.pending = lifetime;
    try {
      if (descriptor?.kind === "review")
        return await this.startReview(record, guard, lifetime);
      return await this.runNative(record, requestId, guard, lifetime, binding);
    } catch (error) {
      lifetime.finish({ error });
      // Settle the exact pending abort before reporting lost admission authority.
      if (
        !lifetime.started &&
        lifetime.abort.signal.aborted &&
        error === lifetime.abort.signal.reason
      )
        guard();
      throw error;
    } finally {
      if (this.pending === lifetime) this.pending = undefined;
    }
  }

  owned(owner: string, id: string) {
    return [this.active, this.pending].find(
      (run) => run?.owner === owner && run.id === id,
    );
  }

  stop() {
    this.pending?.abort.abort();
    this.active?.abort.abort();
  }

  settlementPromises() {
    return [this.pending?.done, this.active?.done];
  }

  async control(
    record: McpCompositeRecord,
    direction: "pause" | "cancel",
    guard: McpCompositeGuard,
  ) {
    assertControlStatus(record, direction);
    const active = this.owned(record.owner, record.id);
    if (active) {
      if (direction === "cancel") active.abort.abort();
      else active.pause = true;
    }
    record.status = direction === "cancel" ? "cancelled" : "paused";
    const saving = saveCompositeRecord(this.repository, record, guard);
    const results = await Promise.allSettled([
      saving,
      direction === "cancel" ? active?.done : undefined,
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        "Composite control could not be fully checkpointed.",
      );
    const saved = results[0];
    if (saved.status === "rejected") throw saved.reason;
    return saved.value;
  }

  private async runNative(
    record: McpCompositeRecord,
    requestId: string,
    guard: McpCompositeGuard,
    lifetime: McpCompositeRunLifetime,
    binding: McpCompositeBinding | undefined,
  ) {
    if (
      !binding ||
      compositeFingerprint(nextCompositePhase(record)?.binding) !==
        compositeFingerprint(savedCompositeBinding(binding))
    )
      compositeError(
        "Session action input is unavailable. Explicitly rebind an unadmitted phase.",
      );
    const check = lifetime.guard(guard);
    await this.native.verify(binding, check);
    check();
    const reserved = await reserveCompositeAttempt(
      this.repository,
      record,
      binding,
      requestId,
      check,
    );
    await this.startReserved(
      check,
      () => reserved.settlement.hold("interrupted"),
      () =>
        this.start(
          reserved.record,
          (signal) =>
            executeCompositeAttempt(
              this.native,
              this.repository,
              reserved.record,
              binding,
              reserved.settlement,
              signal,
              guard,
            ),
          guard,
          lifetime,
        ),
    );
    return reserved.record;
  }
  private async startReview(
    record: McpCompositeRecord,
    guard: McpCompositeGuard,
    lifetime: McpCompositeRunLifetime,
  ) {
    const check = lifetime.guard(guard);
    const prepared = await renderCompositeReview.reserve(
      this.repository,
      record,
      check,
    );
    await this.startReserved(
      check,
      () => renderCompositeReview.hold(this.repository, prepared, guard),
      () =>
        this.start(
          prepared,
          (signal) =>
            renderCompositeReview.execute(
              this.native,
              this.repository,
              prepared,
              signal,
              guard,
            ),
          guard,
          lifetime,
        ),
    );
    return prepared;
  }
  private start(
    record: McpCompositeRecord,
    execute: (signal: AbortSignal) => Promise<unknown>,
    guard: McpCompositeGuard,
    lifetime: McpCompositeRunLifetime,
  ) {
    lifetime.started = true;
    this.active = lifetime;
    this.pending = undefined;
    const done = Promise.resolve()
      .then(() => execute(lifetime.abort.signal))
      .then(async () => {
        if (lifetime.pause) {
          const latest = await this.repository.load(record.owner, record.id);
          if (latest.status === "prepared") {
            latest.status = "paused";
            await saveCompositeRecord(this.repository, latest, guard);
          }
        }
      });
    void done.then(
      () => this.settle(lifetime),
      (error) => this.settle(lifetime, { error }),
    );
  }
  private settle(
    lifetime: McpCompositeRunLifetime,
    failure?: { error: unknown },
  ) {
    if (this.active === lifetime) this.active = undefined;
    lifetime.finish(failure);
  }
  private async startReserved(
    check: McpCompositeGuard,
    hold: () => Promise<unknown>,
    start: () => void,
  ) {
    try {
      check();
      start();
    } catch (error) {
      try {
        await hold();
      } catch (checkpointError) {
        throw new AggregateError(
          [error, checkpointError],
          "Cancelled admission could not be durably held.",
          { cause: checkpointError },
        );
      }
      throw error;
    }
  }
}

function assertControlStatus(
  record: McpCompositeRecord,
  direction: "pause" | "cancel",
) {
  if (record.status === "completed")
    compositeError("Completed parents do not admit further controls.");
  if (
    direction === "pause" &&
    (record.status === "held" ||
      record.status === "awaiting-review" ||
      record.status === "cancelled")
  )
    compositeError(
      "Pause cannot reopen a held, cancelled or pending-review parent.",
    );
}
