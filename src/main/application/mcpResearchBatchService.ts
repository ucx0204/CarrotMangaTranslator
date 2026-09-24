import { createMcpOwnedRunCompletion } from "./mcpOwnedRunCompletion";
import { McpResearchBatchRunSchema } from "../../shared/mcpResearchBatch";
import { hashStableValue } from "../../shared/blockFingerprint";
import type {
  McpResearchBatchPrepare,
  McpResearchBatchResolve,
  McpResearchBatchRun,
} from "../../shared/mcpResearchBatch";
import {
  assertResearchBatchVersion,
  rememberResearchAction,
  researchBatchView,
  type McpResearchBatchRecord,
} from "./mcpResearchBatchPolicy";
import {
  runResearchBatch,
  saveResearchCheckpoint,
  type McpResearchBatchActive,
  type McpResearchBatchRunnerPort,
} from "./mcpResearchBatchRunner";
import { McpEditError } from "./mcpEditPolicy";

type Repository = {
  find: (
    owner: string,
    input: McpResearchBatchPrepare,
  ) => Promise<McpResearchBatchRecord | undefined>;
  create: (
    owner: string,
    input: McpResearchBatchPrepare,
    settings: string,
    guard: () => void,
    verify: () => Promise<void>,
  ) => Promise<McpResearchBatchRecord>;
  load: (owner: string, id: string) => Promise<McpResearchBatchRecord>;
  save: McpResearchBatchRunnerPort["save"];
  list: (owner: string) => Promise<McpResearchBatchRecord[]>;
  discard: (
    owner: string,
    id: string,
    guard: () => void,
  ) => Promise<{ id: string; status: "discarded"; pageChanges: 0 }>;
};
type Ports = Omit<McpResearchBatchRunnerPort, "save"> & {
  repository: Repository;
  prepare: (
    input: McpResearchBatchPrepare,
    guard: () => void,
  ) => Promise<{ settings: string; verifyUnlocked: () => Promise<void> }>;
};

/** Bounded work-level coordination; each model call still belongs to the native job service. */
export class McpResearchBatchService {
  private active?: McpResearchBatchActive;
  private stopped = false;
  readonly completion = createMcpOwnedRunCompletion({
    active: () => this.active,
    load: (owner, id) => this.ports.repository.load(owner, id),
    parse: McpResearchBatchRunSchema.parse,
    project: researchBatchView,
  });
  private admission: Promise<unknown> = Promise.resolve();
  private readonly runner: McpResearchBatchRunnerPort;
  constructor(private readonly ports: Ports) {
    this.runner = {
      ...ports,
      save: ports.repository.save.bind(ports.repository),
    };
  }
  private check(guard: () => void) {
    guard();
    if (this.stopped)
      throw new McpEditError(
        "access_denied",
        "Research batch session is stopping.",
      );
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.admission.then(action);
    this.admission = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  prepare(owner: string, input: McpResearchBatchPrepare, guard: () => void) {
    return this.serialize(async () => {
      this.check(guard);
      const previous = await this.ports.repository.find(owner, input);
      if (previous) {
        this.check(guard);
        return this.view(previous);
      }
      const prepared = await this.ports.prepare(input, guard);
      const value = await this.ports.repository.create(
        owner,
        input,
        prepared.settings,
        () => this.check(guard),
        prepared.verifyUnlocked,
      );
      this.check(guard);
      return this.view(value);
    });
  }
  async get(owner: string, id: string, guard: () => void) {
    this.check(guard);
    const active = this.ownedActive(owner, id);
    const value =
      active?.record ?? (await this.ports.repository.load(owner, id));
    this.check(guard);
    return this.view(value);
  }
  async list(
    owner: string,
    input: { offset: number; limit: number; snapshot?: string },
    guard: () => void,
  ) {
    this.check(guard);
    const records = await this.ports.repository.list(owner);
    const snapshot = hashStableValue(
      records.map((record) => [record.id, record.version]),
    );
    if (
      (input.offset > 0 && !input.snapshot) ||
      (input.snapshot && snapshot !== input.snapshot)
    )
      throw new McpEditError(
        "revision_conflict",
        "Research plans changed; restart pagination.",
      );
    this.check(guard);
    return {
      snapshot,
      total: records.length,
      offset: input.offset,
      limit: input.limit,
      nextOffset:
        input.offset + input.limit < records.length
          ? input.offset + input.limit
          : null,
      items: records
        .slice(input.offset, input.offset + input.limit)
        .map((record) => {
          const { works: _works, ...summary } = this.view(record);
          return summary;
        }),
    };
  }
  run(owner: string, input: McpResearchBatchRun, guard: () => void) {
    return this.serialize(async () => {
      this.check(guard);
      const fingerprint = hashStableValue(["run", input]);
      const active = this.ownedActive(owner, input.id);
      if (this.active) {
        const previous = active?.record.requests.find(
          (item) => item.requestId === input.requestId,
        );
        if (previous?.fingerprint === fingerprint)
          return this.view(this.active.record);
        throw new McpEditError(
          "editor_busy",
          "A research batch is running; wait for its cleanup.",
        );
      }
      const record = await this.ports.repository.load(owner, input.id);
      this.check(guard);
      if (rememberResearchAction(record, input.requestId, fingerprint))
        return this.view(record);
      assertResearchBatchVersion(record, input.version);
      if (record.status === "completed")
        throw new McpEditError(
          "invalid_edit",
          "This research batch is complete; review its retained proposals.",
        );
      record.status = "running";
      const next: McpResearchBatchActive = {
        record,
        controller: new AbortController(),
        pause: false,
        done: Promise.resolve(),
      };
      this.active = next;
      try {
        await saveResearchCheckpoint(this.runner, record, () =>
          this.check(guard),
        );
      } catch (error) {
        this.active = undefined;
        throw error;
      }
      next.done = runResearchBatch(this.runner, next, input, () =>
        this.check(guard),
      )
        .catch(this.ports.reportError)
        .finally(() => {
          if (this.active === next) this.active = undefined;
        });
      return this.view(record);
    });
  }
  resolve(owner: string, input: McpResearchBatchResolve, guard: () => void) {
    return this.serialize(async () => {
      this.assertSettled(guard);
      const record = await this.ports.repository.load(owner, input.id);
      if (
        rememberResearchAction(
          record,
          input.requestId,
          hashStableValue(["resolve", input]),
        )
      )
        return this.view(record);
      assertResearchBatchVersion(record, input.version);
      const row = record.works.find(
        (work) => work.target.workId === input.workId,
      );
      if (!row || row.status !== "held" || row.attempts.length)
        throw new McpEditError(
          "invalid_edit",
          "Resolve only an unattempted held work in this fixed plan.",
        );
      Object.assign(row.target, {
        researchTitle: input.researchTitle,
        titleConfirmed: true,
        allowSpoilers: true,
      });
      row.status = "pending";
      record.status = "paused";
      await saveResearchCheckpoint(this.runner, record, () =>
        this.check(guard),
      );
      return this.view(record);
    });
  }
  async control(
    owner: string,
    id: string,
    direction: "pause" | "cancel",
    guard: () => void,
  ) {
    this.check(guard);
    const active = this.ownedActive(owner, id);
    if (active) {
      if (direction === "pause") active.pause = true;
      else active.controller.abort();
      return this.view(active.record);
    }
    return this.serialize(async () => {
      this.assertSettled(guard);
      const record = await this.ports.repository.load(owner, id);
      if (record.status !== "completed") {
        record.status = direction === "pause" ? "paused" : "cancelled";
        await saveResearchCheckpoint(this.runner, record, () =>
          this.check(guard),
        );
      }
      return this.view(record);
    });
  }
  discard(owner: string, id: string, guard: () => void) {
    return this.serialize(async () => {
      this.assertSettled(guard);
      return this.ports.repository.discard(owner, id, () => this.check(guard));
    });
  }
  stop() {
    this.stopped = true;
    this.active?.controller.abort();
  }
  async close() {
    this.stop();
    await this.admission;
    await this.active?.done;
  }
  private assertSettled(guard: () => void) {
    this.check(guard);
    if (this.active)
      throw new McpEditError(
        "editor_busy",
        "Wait for research cleanup before changing its plan.",
      );
  }
  private ownedActive(owner: string, id: string) {
    if (this.active?.record.id !== id) return undefined;
    if (this.active.record.owner !== owner)
      throw new McpEditError(
        "not_found",
        "Research batch is not owned by this connection.",
      );
    return this.active;
  }
  private view(record: McpResearchBatchRecord) {
    return researchBatchView(
      record,
      this.active?.record.id === record.id ? this.active : undefined,
    );
  }
}
