import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import type { McpImportBatchPrepare } from "../../shared/mcpImportBatch";
import type { McpImportBatchPublish } from "../../shared/mcpImportPublication";
import type { McpImportReceipt } from "../../shared/mcpLibraryImport";
import {
  McpImportBatchRecordSchema,
  type McpImportBatchRecord,
} from "../application/mcpImportBatchState";
import { McpEditError } from "../application/mcpEditPolicy";
import { withLibraryRead, withLibraryMutation } from "../library/lock";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "../libraryStore/libraryTransaction";
import { canonicalizeWebImageUrl } from "../webImportUrlPolicy";
import { McpChapterDiscoveryRepository } from "./mcpChapterDiscoveryRepository";
import { MCP_RETENTION_MS, type RetentionIndex } from "./mcpRetentionRecords";
import type { McpRetentionStorage } from "./mcpRetentionStorage";

/** Plans and checkpoints only. Browser, import and library publication stay native. */
export class McpImportBatchRepository {
  constructor(private readonly storage: McpRetentionStorage) {}
  load(owner: string, id: string) {
    return withLibraryRead(() => this.read(owner, id));
  }
  private async read(owner: string, id: string) {
    const { entry } = await this.storage.owned(owner, id, "import-batch");
    const value = McpImportBatchRecordSchema.parse(
      await this.storage.record(id),
    );
    if (
      value.id !== id ||
      value.owner !== owner ||
      entry.pageCount !== 0 ||
      entry.requestId !== value.input.requestId ||
      entry.createdAt !== value.createdAt ||
      entry.expiresAt !== value.expiresAt ||
      value.expiresAt - value.createdAt !== MCP_RETENTION_MS
    )
      throw new McpEditError(
        "invalid_edit",
        "Import plan index and record disagree.",
      );
    return value;
  }
  private async find(owner: string, input: McpImportBatchPrepare) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.owner === owner &&
        item.kind === "import-batch" &&
        item.requestId === input.requestId,
    );
    if (!entry) return undefined;
    const value = await this.read(owner, entry.id);
    if (value.fingerprint !== hashStableValue(input))
      throw new McpEditError(
        "invalid_edit",
        "Import plan requestId belongs to a different fixed selection.",
      );
    return value;
  }
  async prepare(
    owner: string,
    input: McpImportBatchPrepare,
    guard: () => void,
  ) {
    guard();
    const previous = await withLibraryRead(() => this.find(owner, input));
    guard();
    if (previous) return previous;
    const targets = await this.resolve(owner, input, guard);
    return withLibraryMutation(async () => {
      guard();
      const existing = await this.find(owner, input);
      if (existing) return existing;
      const createdAt = this.storage.now();
      const value = McpImportBatchRecordSchema.parse({
        format: 1,
        id: randomUUID(),
        owner,
        version: 0,
        input,
        fingerprint: hashStableValue(input),
        sourceFingerprint: hashStableValue(targets),
        createdAt,
        expiresAt: createdAt + MCP_RETENTION_MS,
        status: "prepared",
        errorCode: null,
        runs: [],
        items: targets.map((target) => ({
          target,
          attempts: [],
          receipt: null,
        })),
      });
      await runLibraryTransaction(
        "mcp-import-batch-prepare",
        (transaction) =>
          this.storage.stageMetadataRecord(
            transaction,
            {
              id: value.id,
              owner,
              kind: "import-batch",
              operation: "carrot_prepare_import_batch",
              requestId: input.requestId,
              createdAt,
              expiresAt: value.expiresAt,
            },
            value,
          ),
        undefined,
        guard,
      );
      return value;
    });
  }
  private async resolve(
    owner: string,
    input: McpImportBatchPrepare,
    guard: () => void,
  ) {
    const discovery = new McpChapterDiscoveryRepository(this.storage);
    const targets: McpImportBatchRecord["items"][number]["target"][] = [];
    for (const source of input.sources) {
      guard();
      const raw =
        source.kind === "url"
          ? source.url
          : (await discovery.link(owner, source, guard)).url;
      const url = canonicalizeWebImageUrl(raw);
      if (!url || targets.some((target) => target.url === url))
        throw new McpEditError(
          "invalid_edit",
          "Select distinct HTTP(S) URLs without credentials; fragments do not distinguish chapters.",
        );
      targets.push({ id: randomUUID(), label: source.label, url });
    }
    guard();
    return targets;
  }
  async save(
    value: McpImportBatchRecord,
    previousVersion: number,
    guard: () => void,
  ) {
    const next = McpImportBatchRecordSchema.parse(value);
    await withLibraryMutation(async () => {
      guard();
      const current = await this.read(next.owner, next.id);
      if (current.version !== previousVersion)
        throw new McpEditError(
          "revision_conflict",
          "Import preparation plan changed.",
        );
      assertTransition(current, next);
      await runLibraryTransaction(
        "mcp-import-batch-checkpoint",
        (transaction) => this.storage.stageRecord(transaction, next.id, next),
        undefined,
        guard,
      );
    });
  }
  /** Called only while the native import/read transaction already owns the library lock. */
  async validatePublicationUnlocked(
    owner: string,
    input: McpImportBatchPublish,
    guard: () => void,
  ) {
    guard();
    const record = await this.read(owner, input.id);
    if (record.version !== input.version)
      throw new McpEditError(
        "revision_conflict",
        "Read the current import batch version before publishing reviewed pages.",
      );
    for (const selection of input.items) {
      const row = record.items.find(
        (item) => item.target.id === selection.itemId,
      );
      const preview = row?.attempts.at(-1)?.preview;
      if (
        !row ||
        row.receipt ||
        !preview ||
        preview.source !== "web" ||
        preview.previewId !== selection.previewId ||
        preview.snapshot !== selection.snapshot
      )
        throw new McpEditError(
          "invalid_edit",
          "Select only unimported current previews from this owned batch.",
        );
    }
    guard();
    return record;
  }
  /** Chapter files, grouped receipt and plan progression share ONE publication point. */
  async stagePublication(
    transaction: LibraryTransaction,
    index: RetentionIndex,
    owner: string,
    input: McpImportBatchPublish,
    receipt: McpImportReceipt,
    guard: () => void,
  ) {
    const current = await this.validatePublicationUnlocked(owner, input, guard);
    const next = structuredClone(current);
    const selected = new Set(input.items.map((item) => item.itemId));
    for (const row of next.items)
      if (selected.has(row.target.id)) row.receipt = receipt;
    next.version++;
    if (next.items.every((row) => row.receipt)) next.status = "completed";
    assertTransition(current, next);
    await this.storage.stageRecord(
      transaction,
      next.id,
      McpImportBatchRecordSchema.parse(next),
      undefined,
      index,
    );
    guard();
  }
  discard(owner: string, id: string, guard: () => void) {
    return withLibraryMutation(async () => {
      guard();
      const { index } = await this.storage.owned(owner, id, "import-batch");
      await runLibraryTransaction(
        "mcp-import-batch-discard",
        (transaction) => this.storage.retire(transaction, id, index),
        undefined,
        guard,
      );
      return { id, status: "discarded" as const, pageChanges: 0 as const };
    });
  }
}
function assertTransition(
  current: McpImportBatchRecord,
  next: McpImportBatchRecord,
) {
  if (
    next.version !== current.version + 1 ||
    next.fingerprint !== current.fingerprint ||
    next.sourceFingerprint !== current.sourceFingerprint ||
    next.createdAt !== current.createdAt ||
    next.expiresAt !== current.expiresAt ||
    next.runs.length < current.runs.length ||
    hashStableValue(next.runs.slice(0, current.runs.length)) !==
      hashStableValue(current.runs)
  )
    throw new McpEditError(
      "invalid_edit",
      "Invalid import preparation checkpoint transition.",
    );
  for (const [index, row] of current.items.entries()) {
    const changed = next.items[index];
    if (
      changed.attempts.length < row.attempts.length ||
      (row.receipt &&
        hashStableValue(changed.receipt) !== hashStableValue(row.receipt))
    )
      throw new McpEditError(
        "invalid_edit",
        "Completed import evidence cannot be removed from its plan.",
      );
  }
}
