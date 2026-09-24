import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpImportReceiptSchema,
  type McpImportReceipt,
} from "../../shared/mcpLibraryImport";
import {
  McpImportPublicationSchema,
  importPublicationSelections,
  importPublicationChapters,
  importPublicationMapping,
  matchesImportPublication,
  type McpImportPublication,
} from "../../shared/mcpImportPublication";
import type {
  CreateImportFromPreviewRequest,
  CreateImportResult,
  ImportChapterDraft,
} from "../../shared/importTypes";
import type { McpOperationContext } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpPreparedImportMapping } from "../application/mcpImportMappingPolicy";
import {
  matchesMcpImportPageMapping,
  type McpImportPageMapping,
} from "../../shared/mcpImportMapping";
import { McpImportMappingPublication } from "./mcpImportMappingPublication";
import { matchesImageImportMapping } from "./mcpImportMappingIntegrity";
import { withLibraryRead } from "../library/lock";
import { createImport } from "../library/libraryImportFacade";
import { readWorkFile, readChapterFile } from "../libraryStore/libraryFiles";
import type { LibraryTransaction } from "../libraryStore/libraryTransaction";
import { McpImportBatchRepository } from "./mcpImportBatchRepository";
import { inspectImportDuplicatesUnlocked } from "./mcpImportDuplicateInspection";
import type { McpRetentionStorage } from "./mcpRetentionStorage";
import { MCP_RETENTION_MS, type RetentionEntry } from "./mcpRetentionRecords";

const recordSchema = z
  .object({
    format: z.literal(1),
    owner: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
    input: McpImportPublicationSchema,
    receipt: McpImportReceiptSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.fingerprint === hashStableValue(value.input) &&
      matchesImportPublication(value.input, value.receipt) &&
      matchesMcpImportPageMapping(value.receipt) &&
      matchesImageImportMapping(value.input, value.receipt.pageMapping) &&
      value.receipt.expiresAt - value.receipt.createdAt === MCP_RETENTION_MS,
    "Inconsistent retained import receipt.",
  );

/** Uses the existing encrypted catalog and the original import transaction. */
export class McpLibraryImportRepository {
  constructor(
    private readonly storage: McpRetentionStorage,
    private readonly importer = createImport,
  ) {}
  async target(workId: string, guard: () => void) {
    guard();
    return withLibraryRead(async () => {
      const view = await targetUnlocked(workId);
      guard();
      return view;
    });
  }
  duplicates(
    target: McpImportPublication["target"],
    chapters: ImportChapterDraft[],
    guard: () => void,
  ) {
    guard();
    return withLibraryRead(() =>
      inspectImportDuplicatesUnlocked(target, chapters, guard),
    );
  }
  async find(
    owner: string,
    input: McpImportPublication,
  ): Promise<McpImportReceipt | undefined> {
    return withLibraryRead(async () => {
      const found = await this.findUnlocked(owner, input.requestId);
      if (!found) {
        await this.assertUnusedPreviews(owner, input);
        await this.verifyBatch(owner, input, () => {});
        return undefined;
      }
      if (found.fingerprint !== hashStableValue(input))
        throw new McpEditError(
          "invalid_edit",
          "Import requestId belongs to a different selection or destination.",
        );
      return found.receipt;
    });
  }
  async forPreview(owner: string, previewId: string, guard: () => void) {
    guard();
    return withLibraryRead(async () => {
      const entries = (await this.storage.index()).entries.filter(
        (entry) =>
          entry.owner === owner &&
          entry.kind === "import" &&
          entry.expiresAt > this.storage.now(),
      );
      for (const entry of entries) {
        const record = await this.readEntry(owner, entry);
        guard();
        if (
          importPublicationSelections(record.input).some(
            (item) => item.previewId === previewId,
          )
        )
          return record.receipt;
      }
      guard();
      return undefined;
    });
  }
  async inspect(owner: string, requestId: string, guard: () => void) {
    guard();
    return withLibraryRead(async () => {
      const record = await this.findUnlocked(owner, requestId);
      if (!record)
        throw new McpEditError(
          "not_found",
          "No retained import receipt exists for this connection and request.",
        );
      const availableChapterIds: string[] = [];
      const work = await readWorkFile(record.receipt.workId);
      for (const id of record.receipt.chapterIds) {
        if (
          work?.chapterOrder.includes(id) &&
          (await readChapterFile(work.id, id))
        )
          availableChapterIds.push(id);
      }
      guard();
      return {
        ...record.receipt,
        availableChapterIds,
        note: "Historical import receipt; current chapter existence is not content equality or permission to undo." as const,
      };
    });
  }
  async commit(
    owner: string,
    input: McpImportPublication,
    request: CreateImportFromPreviewRequest,
    source: "local" | "web",
    verify: () => Promise<void>,
    context: McpOperationContext,
    mapping?: McpPreparedImportMapping,
  ) {
    context.assertAuthorized();
    await withLibraryRead(async () => {
      await this.verifyDestination(input);
      await this.verifySourcePolicy(input, request, context.assertAuthorized);
    });
    let receipt: McpImportReceipt | undefined;
    const pages = mapping
      ? new McpImportMappingPublication(mapping)
      : undefined;
    await this.importer(request, context.signal, {
      assertCanCommit: context.assertAuthorized,
      ...(pages
        ? {
            observePage: pages.observePage,
            observeMetadata: pages.observeMetadata,
          }
        : {}),
      stage: async (transaction, imported) => {
        const verifyPublication = async () => {
          context.assertAuthorized();
          await this.verifyDestination(input);
          await this.verifyBatch(owner, input, context.assertAuthorized);
          await verify();
          await pages?.verify();
          await this.verifySourcePolicy(
            input,
            request,
            context.assertAuthorized,
          );
          context.assertAuthorized();
        };
        await verifyPublication();
        if (await this.findUnlocked(owner, input.requestId))
          throw new McpEditError(
            "revision_conflict",
            "Import request was already committed. Read its retained receipt.",
          );
        await this.assertUnusedPreviews(owner, input);
        receipt = await this.stageReceipt(
          transaction,
          owner,
          input,
          imported,
          source,
          context.assertAuthorized,
          pages?.finish(imported),
        );
        transaction.beforePublish(verifyPublication);
        context.assertAuthorized();
      },
    });
    if (!receipt)
      throw new Error("Native import completed without its required receipt.");
    return receipt;
  }
  private async verifySourcePolicy(
    input: McpImportPublication,
    request: CreateImportFromPreviewRequest,
    guard: () => void,
  ) {
    if (input.duplicatePolicy !== "reject-known") return;
    const review = await inspectImportDuplicatesUnlocked(
      input.target,
      request.preview.chapters,
      guard,
    );
    if (review.chapters.some((chapter) => chapter.status !== "unseen"))
      throw new McpEditError(
        "invalid_edit",
        "Selected source content or URL is already recorded in this destination or group. Inspect duplicates and explicitly omit known items; nothing in this atomic group was imported.",
      );
  }
  private async stageReceipt(
    transaction: LibraryTransaction,
    owner: string,
    input: McpImportPublication,
    imported: CreateImportResult,
    source: "local" | "web",
    guard: () => void,
    pageMapping?: McpImportPageMapping,
  ) {
    const now = this.storage.now();
    const batch = importPublicationMapping(input, imported.chapterIds);
    const receipt = McpImportReceiptSchema.parse({
      id: randomUUID(),
      requestId: input.requestId,
      status: "imported",
      workId: imported.workId,
      chapterIds: imported.chapterIds,
      pageCount: importPublicationChapters(input).reduce(
        (sum, chapter) => sum + chapter.pageIds.length,
        0,
      ),
      source,
      createdAt: now,
      expiresAt: now + MCP_RETENTION_MS,
      retention: "seven-days",
      ...(pageMapping ? { pageMapping } : {}),
      ...(batch ? { batch } : {}),
    });
    const record = recordSchema.parse({
      format: 1,
      owner,
      fingerprint: hashStableValue(input),
      input,
      receipt,
    });
    const index = await this.storage.prune(
      transaction,
      await this.storage.index(),
    );
    const directory = await this.storage.create(transaction, receipt.id);
    const bytes = await this.storage.writeRecord(
      directory.stagingDirectory,
      record,
    );
    index.entries.push({
      id: receipt.id,
      owner,
      kind: "import",
      operation:
        "items" in input
          ? "carrot_import_batch_chapters"
          : "carrot_import_chapters",
      requestId: input.requestId,
      createdAt: now,
      expiresAt: receipt.expiresAt,
      bytes,
      pageCount: receipt.pageCount,
      mimeType: null,
      sha256: null,
    });
    if ("items" in input)
      await new McpImportBatchRepository(this.storage).stagePublication(
        transaction,
        index,
        owner,
        input,
        receipt,
        guard,
      );
    await this.storage.stageIndex(transaction, index);
    return receipt;
  }
  private async verifyBatch(
    owner: string,
    input: McpImportPublication,
    guard: () => void,
  ) {
    if ("items" in input)
      await new McpImportBatchRepository(
        this.storage,
      ).validatePublicationUnlocked(owner, input, guard);
  }
  private async findUnlocked(owner: string, requestId: string) {
    const entry = (await this.storage.index()).entries.find(
      (item) =>
        item.kind === "import" &&
        item.owner === owner &&
        item.requestId === requestId,
    );
    return entry ? this.readEntry(owner, entry) : undefined;
  }
  private async readEntry(owner: string, entry: RetentionEntry) {
    await this.storage.owned(owner, entry.id, "import");
    const record = recordSchema.parse(await this.storage.record(entry.id));
    if (
      record.owner !== owner ||
      record.receipt.id !== entry.id ||
      record.receipt.requestId !== entry.requestId ||
      record.receipt.createdAt !== entry.createdAt ||
      record.receipt.expiresAt !== entry.expiresAt ||
      record.receipt.pageCount !== entry.pageCount
    )
      throw new McpEditError(
        "invalid_edit",
        "Import receipt metadata is inconsistent.",
      );
    return record;
  }
  private async assertUnusedPreviews(
    owner: string,
    input: McpImportPublication,
  ) {
    const ids = new Set(
      importPublicationSelections(input).map((item) => item.previewId),
    );
    const entries = (await this.storage.index()).entries.filter(
      (entry) =>
        entry.owner === owner &&
        entry.kind === "import" &&
        entry.expiresAt > this.storage.now(),
    );
    for (const entry of entries) {
      const record = await this.readEntry(owner, entry);
      if (
        importPublicationSelections(record.input).some((item) =>
          ids.has(item.previewId),
        )
      )
        throw new McpEditError(
          "invalid_edit",
          `This preview already created library chapters. Inspect import request ${record.receipt.requestId}; a different request cannot import it again.`,
        );
    }
  }
  private async verifyDestination(input: McpImportPublication) {
    if (input.target.mode !== "existing") return;
    if (
      (await targetUnlocked(input.target.workId)).snapshot !==
      input.target.snapshot
    )
      throw new McpEditError(
        "revision_conflict",
        "Import destination changed. Read the current work before preparing another explicit import.",
      );
  }
}
async function targetUnlocked(workId: string) {
  const work = await readWorkFile(workId);
  if (!work)
    throw new McpEditError(
      "not_found",
      "Import destination work no longer exists.",
    );
  return {
    workId,
    title: work.title,
    snapshot: hashStableValue(work),
    chapterCount: work.chapterOrder.length,
  };
}
