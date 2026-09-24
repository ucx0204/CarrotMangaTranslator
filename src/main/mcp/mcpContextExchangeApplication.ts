import { extname } from "node:path";
import {
  McpContextImportApplySchema,
  McpContextImportPreviewSchema,
  McpContextImportReviewSchema,
  type McpContextImportApply,
  type McpContextImportPreview,
} from "../../shared/mcpContextExchange";
import { decodeMcpContextExchangePayload } from "../../shared/mcpContextExchangePayload";
import { prepareMcpContextImport } from "../application/mcpContextExchangePolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { readWorkContextReferences } from "../library/libraryContextEditingFacade";
import type { McpContextMigrationApplication } from "./mcpContextMigrationApplication";
import type { McpFileUploadStore } from "./mcpFileUploadStore";
import { readMcpExchangeUpload } from "./mcpExchangeUpload";

type Asset = ReturnType<typeof decodeMcpContextExchangePayload> & {
  sourceSha256: string;
  sourceBytes: number;
  expiresAt: number;
  verify: () => Promise<void>;
  guard: () => void;
};

/** Owned input is a temporary lease; native context recovery is independently durable. */
export class McpContextExchangeApplication {
  constructor(
    private readonly uploads: McpFileUploadStore,
    private readonly migration: McpContextMigrationApplication,
    private readonly lifetime: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {}

  preview(
    owner: string,
    value: McpContextImportPreview,
    guard: () => void,
    signal?: AbortSignal,
  ) {
    const input = McpContextImportPreviewSchema.parse(value);
    const check = this.guard(guard, signal);
    return this.withInput(owner, input.uploadId, check, async (asset) => {
      const graph = await readWorkContextReferences(
        input.chapterId,
        asset.guard,
      );
      const plan = prepareMcpContextImport(
        graph,
        asset.payload,
        asset.sourceSha256,
        input,
        new Date(this.now()).toISOString(),
        asset.guard,
        asset.nativeNormalization,
      );
      await asset.verify();
      check();
      const end = input.offset + input.limit;
      return McpContextImportReviewSchema.parse({
        uploadId: input.uploadId,
        requestId: input.requestId,
        workId: graph.workId,
        chapterId: input.chapterId,
        sourceBytes: asset.sourceBytes,
        sourceSha256: asset.sourceSha256,
        uploadExpiresAt: asset.expiresAt,
        referenceSnapshot: plan.referenceSnapshot,
        planFingerprint: plan.planFingerprint,
        targetMode: "partial-native-context",
        retention: "requires-live-upload-until-apply",
        totalChanges: plan.changes.length,
        offset: input.offset,
        limit: input.limit,
        nextOffset: end < plan.changes.length ? end : null,
        changes: plan.changes.slice(input.offset, end),
        diagnostics: plan.diagnostics,
        warnings: [
          "uploaded_context_is_untrusted_data",
          "native_reference_state_is_rechecked_before_publication",
          "no_implicit_catalog_replacement_or_memory_freshness_claim",
        ],
      });
    });
  }

  async apply(
    owner: string,
    value: McpContextImportApply,
    guard: () => void,
    signal?: AbortSignal,
  ) {
    const input = McpContextImportApplySchema.parse(value);
    const check = this.guard(guard, signal);
    const operation = "carrot_apply_context_import";
    const replay = await this.migration.replayIntent(
      owner,
      input,
      check,
      operation,
    );
    if (replay) return replay;
    return this.withInput(owner, input.uploadId, check, async (asset) => {
      await asset.verify();
      return this.migration.applyIntent(
        owner,
        input,
        asset.guard,
        (graph, now, assertAccess) =>
          prepareMcpContextImport(
            graph,
            asset.payload,
            asset.sourceSha256,
            input,
            now,
            assertAccess,
            asset.nativeNormalization,
          ),
        operation,
      );
    });
  }

  private withInput<T>(
    owner: string,
    uploadId: string,
    guard: () => void,
    consume: (asset: Asset) => Promise<T>,
  ) {
    return this.uploads.withFile(owner, uploadId, guard, async (upload) => {
      upload.guard();
      if (extname(upload.input.filename).toLowerCase() !== ".json")
        throw new McpEditError(
          "invalid_edit",
          "Select an owned context JSON file.",
        );
      const source = await readMcpExchangeUpload(upload);
      upload.guard();
      let parsed: ReturnType<typeof decodeMcpContextExchangePayload>;
      try {
        parsed = decodeMcpContextExchangePayload(source.bytes);
      } catch (error) {
        throw new McpEditError(
          "invalid_edit",
          error instanceof Error ? error.message : "Invalid context JSON.",
        );
      }
      await source.verify();
      return consume({
        ...parsed,
        sourceSha256: source.sha256,
        sourceBytes: source.bytes.length,
        expiresAt: upload.expiresAt,
        verify: source.verify,
        guard: upload.guard,
      });
    });
  }

  private guard(guard: () => void, signal?: AbortSignal) {
    return () => {
      this.lifetime.throwIfAborted();
      signal?.throwIfAborted();
      guard();
    };
  }
}
