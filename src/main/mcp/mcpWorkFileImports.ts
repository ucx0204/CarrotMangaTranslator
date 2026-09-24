import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpWorkFileCreateSchema,
  McpWorkFileReceiptSchema,
  matchesWorkFileReceipt,
  type McpWorkFileAppendReview,
  type McpWorkFileCreate,
  type McpWorkFileReceipt,
} from "../../shared/mcpWorkFileImport";
import type { WorkShareImportResult } from "../../shared/shareTypes";
import type { McpOperationContext } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpImportPageMapping } from "../../shared/mcpImportMapping";
import { McpImportMappingPublication } from "./mcpImportMappingPublication";
import { matchesWorkFileImportMapping } from "./mcpImportMappingIntegrity";
import { importWorkShare } from "../library/libraryShareFacade";
import { withLibraryRead } from "../library/lock";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import { MCP_RETENTION_MS, type RetentionEntry } from "./mcpRetentionRecords";
import {
  McpWorkFileSource,
  selectWorkFileChapters,
  prepareWorkFilePageMapping,
  type WorkFileAsset,
} from "./mcpWorkFileSource";
import {
  prepareWorkFileAppend,
  reviewWorkFileAppend,
} from "./mcpWorkFileAppend";

const recordSchema = z
  .object({
    version: z.literal(1),
    owner: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    input: McpWorkFileCreateSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
    receipt: McpWorkFileReceiptSchema,
  })
  .strict()
  .refine(
    (record) =>
      record.fingerprint === hashStableValue(record.input) &&
      matchesWorkFileReceipt(record.input, record.receipt) &&
      matchesWorkFileImportMapping(record.input, record.receipt.pageMapping) &&
      record.receipt.expiresAt - record.receipt.createdAt === MCP_RETENTION_MS,
    "Inconsistent retained working-file receipt.",
  );

/** Adapts the existing share transaction and retention catalog; never owns a second importer. */
export class McpWorkFileImports {
  private readonly consumed = new Set<string>();
  constructor(
    private readonly source: McpWorkFileSource,
    private readonly storage: McpRetentionStorage,
    private readonly importer = importWorkShare,
  ) {}
  preview(owner: string, id: string, guard: () => void) {
    return this.source.preview(owner, id, guard);
  }
  previewAppend(
    owner: string,
    input: McpWorkFileAppendReview,
    guard: () => void,
  ) {
    return this.source.use(owner, input.uploadId, guard, async (asset) => {
      const plan = await reviewWorkFileAppend(input, asset, guard);
      await asset.verify();
      return plan.review;
    });
  }
  async get(owner: string, requestId: string, guard: () => void) {
    guard();
    return withLibraryRead(async () => {
      const found = await this.findRequest(owner, requestId);
      guard();
      if (!found)
        throw new McpEditError(
          "not_found",
          "No retained working-file import exists for this connection and request.",
        );
      return found.receipt;
    });
  }
  reviewMapping(owner: string, input: McpWorkFileCreate, guard: () => void) {
    return this.source.use(owner, input.uploadId, guard, async (asset) => {
      const mapping = prepareWorkFilePageMapping(input, asset);
      const append = await prepareWorkFileAppend(input, asset, guard);
      await asset.verify();
      await append?.verify();
      guard();
      return mapping.review;
    });
  }
  async create(
    owner: string,
    input: McpWorkFileCreate,
    context: McpOperationContext,
  ) {
    context.assertAuthorized();
    const previous = await withLibraryRead(() => this.findInput(owner, input));
    context.assertAuthorized();
    if (previous) return { status: "imported", workFileReceipt: previous };
    const key = `${owner}:${input.uploadId}`;
    if (this.consumed.has(key))
      throw new McpEditError(
        "invalid_edit",
        "This upload already imported chapters. Receipt disposal does not permit a second import.",
      );
    const receipt = await this.source.use(
      owner,
      input.uploadId,
      context.assertAuthorized,
      (asset) => this.publish(owner, input, asset, context, key),
      context.signal,
    );
    this.consumed.add(key);
    return { status: "imported", workFileReceipt: receipt };
  }
  private async publish(
    owner: string,
    input: McpWorkFileCreate,
    asset: WorkFileAsset,
    context: McpOperationContext,
    key: string,
  ) {
    const pageCount = selectWorkFileChapters(input, asset.review);
    const pages = new McpImportMappingPublication(
      prepareWorkFilePageMapping(input, asset),
    );
    const append = await prepareWorkFileAppend(
      input,
      asset,
      context.assertAuthorized,
    );
    const verify = async () => {
      await asset.verify();
      await append?.verify();
      await pages.verify();
      context.assertAuthorized();
    };
    let staged: McpWorkFileReceipt | undefined;
    await this.importer(
      {
        packagePath: asset.path,
        target:
          input.target.mode === "append"
            ? { mode: "append", workId: input.target.workId }
            : input.target,
        entries: input.chapters.map((chapter) => ({
          source: "package",
          ...chapter,
        })),
      },
      context.signal,
      {
        assertCanCommit: context.assertAuthorized,
        observePage: pages.observePage,
        observeMetadata: pages.observeMetadata,
        ...(append ? { mapChapter: append.mapChapter } : {}),
        stage: async (transaction, result) => {
          await verify();
          if (this.consumed.has(key) || (await this.findInput(owner, input)))
            throw new McpEditError(
              "revision_conflict",
              "This work-file import committed concurrently. Read its original receipt.",
            );
          staged = await this.stageReceipt(
            transaction,
            owner,
            input,
            result,
            pageCount,
            pages.finish(result),
          );
          transaction.beforePublish(verify);
          context.assertAuthorized();
        },
      },
    );
    if (!staged)
      throw new Error(
        "Native share import completed without its required receipt.",
      );
    return staged;
  }
  private async stageReceipt(
    transaction: LibraryTransaction,
    owner: string,
    input: McpWorkFileCreate,
    result: WorkShareImportResult,
    pageCount: number,
    pageMapping: McpImportPageMapping,
  ) {
    const now = this.storage.now();
    const receipt = McpWorkFileReceiptSchema.parse({
      id: randomUUID(),
      requestId: input.requestId,
      uploadId: input.uploadId,
      snapshot: input.snapshot,
      status: "imported",
      workId: result.workId,
      chapterIds: result.chapterIds,
      packageChapterIds: input.chapters.map(
        (chapter) => chapter.packageChapterId,
      ),
      pageCount,
      createdAt: now,
      expiresAt: now + MCP_RETENTION_MS,
      retention: "seven-days",
      format: "mgtshare-v1",
      pageMapping,
    });
    const record = recordSchema.parse({
      version: 1,
      owner,
      input,
      fingerprint: hashStableValue(input),
      receipt,
    });
    await this.storage.stageMetadataRecord(
      transaction,
      {
        id: receipt.id,
        owner,
        kind: "work-file-import",
        operation: "carrot_import_work_file",
        requestId: input.requestId,
        createdAt: now,
        expiresAt: receipt.expiresAt,
        pageCount,
      },
      record,
    );
    return receipt;
  }
  private async findInput(owner: string, input: McpWorkFileCreate) {
    const previous = await this.findRequest(owner, input.requestId);
    if (previous) {
      if (previous.fingerprint !== hashStableValue(input))
        throw new McpEditError(
          "invalid_edit",
          "Working-file requestId belongs to another selection or title.",
        );
      return previous.receipt;
    }
    const entries = (await this.storage.index()).entries.filter(
      (entry) =>
        entry.owner === owner &&
        entry.kind === "work-file-import" &&
        entry.expiresAt > this.storage.now(),
    );
    for (const entry of entries) {
      if ((await this.read(owner, entry)).receipt.uploadId === input.uploadId)
        throw new McpEditError(
          "invalid_edit",
          "This upload already imported chapters. Use the original request receipt.",
        );
    }
    return undefined;
  }
  private async findRequest(owner: string, requestId: string) {
    const entries = (await this.storage.index()).entries.filter(
      (entry) =>
        entry.owner === owner &&
        entry.kind === "work-file-import" &&
        entry.requestId === requestId,
    );
    if (entries.length > 1)
      throw new Error("Duplicate working-file receipt identity.");
    return entries[0] ? this.read(owner, entries[0]) : undefined;
  }
  private async read(owner: string, entry: RetentionEntry) {
    await this.storage.owned(owner, entry.id, "work-file-import");
    const record = recordSchema.parse(await this.storage.record(entry.id));
    const receipt = record.receipt;
    if (
      record.owner !== owner ||
      receipt.id !== entry.id ||
      receipt.requestId !== entry.requestId ||
      receipt.pageCount !== entry.pageCount ||
      receipt.createdAt !== entry.createdAt ||
      receipt.expiresAt !== entry.expiresAt ||
      entry.operation !== "carrot_import_work_file" ||
      entry.mimeType !== null ||
      entry.sha256 !== null
    )
      throw new McpEditError(
        "invalid_edit",
        "Working-file receipt and retained catalog disagree.",
      );
    return record;
  }
}
