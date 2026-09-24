import type {
  McpCompositeRecord,
  McpCompositeRepository as CompositeRepositoryPort,
} from "../application/mcpCompositeWorkflowPorts";
import { parseCompositeRecord } from "../application/mcpCompositeWorkflowRecord";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  withLibraryRead,
  withLibraryMutation,
  withLibraryArtifactCleanup,
} from "../library/lock";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "../libraryStore/libraryTransaction";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import type { RetentionIndex } from "./mcpRetentionRecords";
import { createCompositeSettlement } from "./mcpCompositeRepositorySettlement";
import {
  assertCompositeInitialRecord,
  assertCompositeTransition,
  assertCompositeOrdinarySave,
  assertCompositeNativeReservation,
  sameCompositeValue,
} from "./mcpCompositeRepositoryValidation";

const operation = "carrot_prepare_composite";
type Guard = () => void;

/** Native metadata adapter only. Children retain their own job, publication and
 * recovery authority; this record never becomes a native execution payload. */
export class McpCompositeRepository implements CompositeRepositoryPort {
  private readonly active = new Map<string, object>();
  constructor(readonly storage: McpRetentionStorage) {}

  isActive(id: string) {
    return this.active.has(id);
  }

  async load(owner: string, id: string) {
    return withLibraryRead(() => this.read(owner, id));
  }

  async find(owner: string, requestId: string) {
    return withLibraryRead(() => this.findUnlocked(owner, requestId));
  }

  async list(owner: string) {
    return withLibraryRead(async () => {
      const entries = await this.storage.listOwned(owner, "composite-workflow");
      return Promise.all(entries.map((entry) => this.read(owner, entry.id)));
    });
  }

  async create(input: McpCompositeRecord, guard: Guard) {
    const record = parseCompositeRecord(input);
    assertCompositeInitialRecord(record);
    return withLibraryMutation(async () => {
      guard();
      const prior = await this.findUnlocked(
        record.owner,
        record.plan.requestId,
      );
      if (prior) {
        if (
          !sameCompositeValue(prior.plan, record.plan) ||
          prior.initialFingerprint !== record.initialFingerprint
        )
          throw new McpEditError(
            "invalid_edit",
            "Composite preparation requestId belongs to another plan.",
          );
        guard();
        return prior;
      }
      const checked = this.admissionGuard(record, guard);
      await runLibraryTransaction(
        "mcp-composite-prepare",
        async (transaction) => {
          await this.storage.stageMetadataRecord(
            transaction,
            {
              id: record.id,
              owner: record.owner,
              kind: "composite-workflow",
              operation,
              requestId: record.plan.requestId,
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
              pageCount: record.targets.length,
            },
            record,
          );
          transaction.beforePublish(async () => checked());
        },
        undefined,
        checked,
      );
      return record;
    });
  }

  async save(input: McpCompositeRecord, expectedVersion: number, guard: Guard) {
    const next = parseCompositeRecord(input);
    return withLibraryMutation(async () => {
      guard();
      const current = await this.read(next.owner, next.id);
      assertCompositeTransition(current, next, expectedVersion);
      assertCompositeOrdinarySave(current, next, this.isActive(next.id));
      await this.write(next, this.admissionGuard(current, guard));
      return next;
    });
  }

  async reserve(
    input: McpCompositeRecord,
    expectedVersion: number,
    guard: Guard,
  ) {
    const next = parseCompositeRecord(input);
    return withLibraryMutation(async () => {
      guard();
      if (this.isActive(next.id))
        throw new McpEditError(
          "editor_busy",
          "Composite already owns an active child.",
        );
      const current = await this.read(next.owner, next.id);
      assertCompositeTransition(current, next, expectedVersion);
      const index = assertCompositeNativeReservation(current, next);
      await this.write(next, this.admissionGuard(current, guard));
      const lease = {};
      const identity = structuredClone(next);
      this.active.set(identity.id, lease);
      const release = () => {
        if (this.active.get(identity.id) === lease)
          this.active.delete(identity.id);
      };
      return {
        record: next,
        settlement: createCompositeSettlement(
          identity,
          index,
          (change) => this.settle(identity, index, change),
          this.storage.now,
          release,
        ),
      };
    });
  }

  async discard(owner: string, id: string, guard: Guard) {
    return withLibraryMutation(async () => {
      guard();
      if (this.isActive(id))
        throw new McpEditError(
          "editor_busy",
          "Wait for the owned child's physical cleanup before discarding its parent.",
        );
      const { index } = await this.storage.owned(
        owner,
        id,
        "composite-workflow",
      );
      await runLibraryTransaction(
        "mcp-composite-discard",
        async (transaction) => {
          await this.storage.retire(transaction, id, index);
          transaction.beforePublish(async () => guard());
        },
        undefined,
        guard,
      );
      return { id, status: "discarded" as const, pageChanges: 0 as const };
    });
  }

  private async findUnlocked(
    owner: string,
    requestId: string,
  ): Promise<McpCompositeRecord | null> {
    const entries = (await this.storage.index()).entries.filter(
      (entry) =>
        entry.kind === "composite-workflow" &&
        entry.owner === owner &&
        entry.requestId === requestId,
    );
    if (entries.length > 1)
      throw new Error("Duplicate composite preparation history.");
    return entries[0] ? this.read(owner, entries[0].id) : null;
  }

  private async read(
    owner: string,
    id: string,
    settlement = false,
  ): Promise<McpCompositeRecord> {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.id === id &&
        item.owner === owner &&
        item.kind === "composite-workflow",
    );
    if (!entry || (!settlement && entry.expiresAt <= this.storage.now()))
      throw new McpEditError(
        "not_found",
        "Composite is missing, expired or owned by another connection.",
      );
    const record = parseCompositeRecord(await this.storage.record(id));
    if (
      !sameCompositeValue(
        [
          record.id,
          record.owner,
          record.createdAt,
          record.expiresAt,
          record.plan.requestId,
          record.targets.length,
          operation,
          null,
          null,
        ],
        [
          entry.id,
          entry.owner,
          entry.createdAt,
          entry.expiresAt,
          entry.requestId,
          entry.pageCount,
          entry.operation,
          entry.mimeType,
          entry.sha256,
        ],
      )
    )
      throw new McpEditError(
        "invalid_edit",
        "Composite metadata and encrypted index disagree.",
      );
    return record;
  }

  private admissionGuard(record: McpCompositeRecord, guard: Guard): Guard {
    return () => {
      guard();
      if (record.expiresAt <= this.storage.now())
        throw new McpEditError(
          "not_found",
          "Composite admission expired before publication.",
        );
    };
  }

  /** Called under the existing native write lock. Record and changed pageCount
   * share one index publication, including zero-bound imported parents. */
  private async write(record: McpCompositeRecord, guard?: Guard) {
    const checked = parseCompositeRecord(record);
    await runLibraryTransaction(
      "mcp-composite-checkpoint",
      async (transaction) => {
        const index = await this.storage.index();
        this.updateEntry(index, checked);
        await this.stage(transaction, index, checked);
        if (guard) transaction.beforePublish(async () => guard());
      },
      undefined,
      guard,
    );
  }

  private updateEntry(index: RetentionIndex, record: McpCompositeRecord) {
    const entry = index.entries.find(
      (item) =>
        item.id === record.id &&
        item.owner === record.owner &&
        item.kind === "composite-workflow",
    );
    if (!entry)
      throw new Error("Composite checkpoint has no owned index entry.");
    entry.pageCount = record.targets.length;
  }

  private async stage(
    transaction: LibraryTransaction,
    index: RetentionIndex,
    record: McpCompositeRecord,
  ) {
    await this.storage.stageRecord(
      transaction,
      record.id,
      record,
      undefined,
      index,
    );
    await this.storage.stageIndex(transaction, index);
  }

  private async settle(
    identity: McpCompositeRecord,
    phaseIndex: number,
    change: (record: McpCompositeRecord) => McpCompositeRecord,
  ) {
    return withLibraryArtifactCleanup(async () => {
      const current = await this.read(identity.owner, identity.id, true);
      const next = parseCompositeRecord(change(structuredClone(current)));
      if (sameCompositeValue(current, next)) return current;
      assertCompositeTransition(current, next, current.version);
      assertSettlementScope(current, next, phaseIndex);
      await this.write(next);
      return next;
    });
  }
}

function assertSettlementScope(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
  phaseIndex: number,
) {
  const allowed = {
    ...current,
    version: next.version,
    updatedAt: next.updatedAt,
    status: next.status,
    stopReason: next.stopReason,
    usageUnknown: next.usageUnknown,
    phases: current.phases.map((phase, index) =>
      index === phaseIndex ? next.phases[index] : phase,
    ),
  };
  if (!sameCompositeValue(allowed, next))
    throw new McpEditError(
      "invalid_edit",
      "Settlement cannot change approved scope, snapshots or reserved budgets.",
    );
}
