import { randomUUID } from "node:crypto";
import {
  McpSyncOutputSchema,
  McpGetOutputSyncSchema,
  McpOutputSyncIdSchema,
  type McpSyncOutput,
  type McpOutputSyncPreflight,
  type McpOutputSyncEffect,
  type McpOutputSyncResult,
} from "../../shared/mcpOutputSync";
import {
  RetainedOutputSyncSchema,
  sameOutputSyncValue,
  type McpOutputSyncIntent,
  type RetainedOutputSync,
} from "../../shared/mcpOutputSyncState";
import {
  createOutputSyncRecord,
  assertOutputSyncRequest,
  admitOutputSyncIntent,
  settleOutputSyncEffect,
  finishOutputSyncRecord,
  failOutputSyncRecord,
  projectOutputSyncReceipt,
} from "../application/mcpOutputSyncPolicy";
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

type Guard = () => void;
type Selector = { id: string } | { requestId: string };
type Settlement = { settle: (effect: McpOutputSyncEffect) => Promise<void> };
export type McpOutputSyncSession = {
  recordIntent: (
    intent: McpOutputSyncIntent,
    guard: Guard,
  ) => Promise<Settlement>;
  finish: (
    result: McpOutputSyncResult,
  ) => Promise<ReturnType<typeof projectOutputSyncReceipt>>;
  fail: (
    errorCode: NonNullable<McpOutputSyncResult["errorCode"]>,
    cancelled: boolean,
  ) => Promise<ReturnType<typeof projectOutputSyncReceipt>>;
};

/** Encrypted intent/effect authority. External paths never become filesystem inputs here.
 * Every mutation uses the existing native lock, transaction journal and retained index.
 * A reconstructed repository can inspect history, but cannot recreate a session capability. */
export class McpOutputSyncRepository {
  private readonly active = new Set<string>();
  constructor(readonly storage: McpRetentionStorage) {}

  isActive(id: string) {
    return this.active.has(id);
  }

  async find(owner: string, input: McpSyncOutput, guard: Guard) {
    const request = McpSyncOutputSchema.parse(input);
    return withLibraryRead(async () => {
      guard();
      const record = await this.findUnlocked(owner, request.requestId);
      if (!record) return undefined;
      assertOutputSyncRequest(record, request);
      guard();
      return projectOutputSyncReceipt(record, this.isActive(record.id), true);
    });
  }

  async begin(
    owner: string,
    input: { request: McpSyncOutput; jobId: string },
    review: McpOutputSyncPreflight,
    guard: Guard,
  ) {
    const request = McpSyncOutputSchema.parse(input.request);
    McpOutputSyncIdSchema.parse(owner);
    return withLibraryMutation(async () => {
      guard();
      const prior = await this.findUnlocked(owner, request.requestId);
      if (prior) {
        assertOutputSyncRequest(prior, request);
        guard();
        return {
          id: prior.id,
          historical: true,
          receipt: projectOutputSyncReceipt(
            prior,
            this.isActive(prior.id),
            true,
          ),
        };
      }
      const record = createOutputSyncRecord({
        id: randomUUID(),
        owner,
        jobId: input.jobId,
        request,
        review,
        now: this.storage.now(),
      });
      const admissionGuard = () => {
        guard();
        this.assertLive(record);
      };
      await runLibraryTransaction(
        "mcp-output-sync-begin",
        async (transaction) => {
          await this.publish(transaction, record);
          transaction.beforePublish(async () => admissionGuard());
        },
        undefined,
        admissionGuard,
      );
      this.active.add(record.id);
      return {
        id: record.id,
        historical: false,
        receipt: projectOutputSyncReceipt(record, true, false),
        session: this.session(record),
      };
    });
  }

  async inspect(owner: string, input: Selector, guard: Guard) {
    return this.readOwned(owner, input, guard, (record) =>
      projectOutputSyncReceipt(record, this.isActive(record.id), true),
    );
  }

  /** Native adapter only: guarded, owned, bounded evidence input; never a tool result. */
  async inspectEvidenceInput(owner: string, id: string, guard: Guard) {
    return this.readOwned(owner, { id }, guard, (record) => ({
      selection: {
        chapterId: record.request.chapterId,
        connectionId: record.request.connectionId,
        pageIds: [...record.request.pageIds],
      },
      destinationSnapshot: record.request.destinationSnapshot,
      targets: record.admissions.map((item) => structuredClone(item.intent)),
    }));
  }

  private async readOwned<T>(
    owner: string,
    input: Selector,
    guard: Guard,
    project: (record: RetainedOutputSync) => T,
  ) {
    const selector = McpGetOutputSyncSchema.parse(input);
    return withLibraryRead(async () => {
      guard();
      const record =
        "id" in selector
          ? await this.load(owner, selector.id)
          : await this.findUnlocked(owner, selector.requestId);
      if (!record)
        throw new McpEditError(
          "not_found",
          "Output sync receipt is unavailable.",
        );
      guard();
      return project(record);
    });
  }

  private async findUnlocked(owner: string, requestId: string) {
    const entries = (await this.storage.index()).entries.filter(
      (entry) =>
        entry.kind === "output-sync" &&
        entry.owner === owner &&
        entry.requestId === requestId,
    );
    if (entries.length > 1)
      throw new Error("Duplicate output sync request history.");
    return entries[0] ? this.load(owner, entries[0].id) : undefined;
  }

  private async load(
    owner: string,
    id: string,
    admitted = false,
  ): Promise<RetainedOutputSync> {
    const index = await this.storage.index();
    const entry = index.entries.find(
      (item) =>
        item.id === id && item.owner === owner && item.kind === "output-sync",
    );
    if (!entry || (!admitted && entry.expiresAt <= this.storage.now()))
      throw new McpEditError(
        "not_found",
        "Output sync receipt is missing, expired or owned by another connection.",
      );
    const record = RetainedOutputSyncSchema.parse(
      await this.storage.record(id),
    );
    if (
      !sameOutputSyncValue(
        [
          record.id,
          record.owner,
          record.createdAt,
          record.expiresAt,
          record.request.requestId,
          record.request.pageIds.length,
          "carrot_sync_output",
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
      throw new Error("Output sync receipt and encrypted index disagree.");
    return record;
  }

  private async publish(
    transaction: LibraryTransaction,
    record: RetainedOutputSync,
  ) {
    const index = await this.storage.prune(
      transaction,
      await this.storage.index(),
    );
    const directory = await this.storage.create(transaction, record.id);
    const bytes = await this.storage.writeRecord(
      directory.stagingDirectory,
      record,
    );
    index.entries.push({
      id: record.id,
      owner: record.owner,
      kind: "output-sync",
      operation: "carrot_sync_output",
      requestId: record.request.requestId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      bytes,
      pageCount: record.request.pageIds.length,
      mimeType: null,
      sha256: null,
    });
    await this.storage.stageIndex(transaction, index);
  }

  private assertLive(record: RetainedOutputSync) {
    if (record.expiresAt <= this.storage.now())
      throw new McpEditError(
        "not_found",
        "Output sync admission expired before publication.",
      );
  }

  private session(initial: RetainedOutputSync): McpOutputSyncSession {
    let tail = Promise.resolve();
    let failure: unknown;
    let closed = false;
    const enqueue = <T>(
      action: () => Promise<T>,
      admission: boolean,
    ): Promise<T> => {
      const pending = tail.then(async () => {
        if (admission && (closed || failure))
          throw new Error("Output sync admission is closed.", {
            cause: failure,
          });
        return action();
      });
      // The caller receives the original rejection. The tail records it and blocks
      // further admissions while still allowing settlement of an already issued intent.
      tail = pending.then(
        () => undefined,
        (error: unknown) => {
          failure = error;
        },
      );
      return pending;
    };
    const finish = async (
      change: (record: RetainedOutputSync) => RetainedOutputSync,
    ) => {
      closed = true;
      try {
        const record = await enqueue(() => this.update(initial, change), false);
        return projectOutputSyncReceipt(record, false, false);
      } finally {
        this.active.delete(initial.id);
      }
    };
    return {
      recordIntent: (intent, guard) =>
        enqueue(async () => {
          const record = await this.update(
            initial,
            (current) =>
              admitOutputSyncIntent(current, intent, this.storage.now()),
            guard,
          );
          const admitted = record.admissions[record.admissions.length - 1];
          return {
            settle: (effect) =>
              enqueue(async () => {
                await this.update(initial, (current) => {
                  const actual = current.admissions[admitted.sequence];
                  if (
                    !actual ||
                    !sameOutputSyncValue(actual.intent, admitted.intent)
                  )
                    throw new Error(
                      "Output sync settlement capability no longer matches its admission.",
                    );
                  return settleOutputSyncEffect(
                    current,
                    admitted.sequence,
                    effect,
                  );
                });
              }, false),
          };
        }, true),
      finish: (result) =>
        finish((current) =>
          finishOutputSyncRecord(current, result, this.storage.now()),
        ),
      fail: (errorCode, cancelled) =>
        finish((current) =>
          failOutputSyncRecord(
            current,
            errorCode,
            cancelled,
            this.storage.now(),
          ),
        ),
    };
  }

  private async update(
    identity: RetainedOutputSync,
    change: (record: RetainedOutputSync) => RetainedOutputSync,
    guard?: Guard,
  ) {
    const lock = guard ? withLibraryMutation : withLibraryArtifactCleanup;
    return lock(async () => {
      guard?.();
      const current = await this.load(identity.owner, identity.id, !guard);
      if (
        current.jobId !== identity.jobId ||
        current.signature !== identity.signature ||
        current.reviewHash !== identity.reviewHash ||
        current.createdAt !== identity.createdAt
      )
        throw new Error("Output sync receipt identity changed.");
      const next = change(current);
      if (next === current) return current;
      const admissionGuard = guard
        ? () => {
            guard();
            this.assertLive(current);
          }
        : undefined;
      await runLibraryTransaction(
        "mcp-output-sync-settlement",
        async (transaction) => {
          await this.storage.stageRecord(
            transaction,
            current.id,
            RetainedOutputSyncSchema.parse(next),
          );
          if (admissionGuard)
            transaction.beforePublish(async () => admissionGuard());
        },
        undefined,
        admissionGuard,
      );
      return next;
    });
  }
}
