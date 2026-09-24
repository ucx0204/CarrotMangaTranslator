import type { McpUploadedImport } from "../../shared/mcpFileUploads";
import { randomUUID } from "node:crypto";
import { hashStableValue } from "../../shared/blockFingerprint";
import type {
  CreateImportFromPreviewRequest,
  ImportChapterDraft,
} from "../../shared/importTypes";
import {
  McpImportPreviewReferenceSchema,
  type McpChooseImport,
  type McpScanImport,
  type mcpLibraryImportOutputs,
} from "../../shared/mcpLibraryImport";
import {
  importPublicationSelections,
  type McpImportPublication,
  type McpImportSelection,
} from "../../shared/mcpImportPublication";
import type { McpImportDuplicates } from "../../shared/mcpImportDuplicates";
import { selectMcpImport } from "./mcpImportSelection";
import type { McpOperationContext } from "./mcpOperationService";
import { McpEditError } from "./mcpEditPolicy";

import type {
  McpImportEntry as Entry,
  McpLibraryImportPorts,
} from "./mcpLibraryImportTypes";
import {
  prepareMcpImageImportMapping,
  type McpImportSourcePageIdentity,
} from "./mcpImportMappingPolicy";
/** Owns only reviewed input capabilities, never a second importer or library. */
export class McpLibraryImportService {
  private readonly entries = new Map<string, Entry>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly ports: McpLibraryImportPorts) {}
  private check(guard: () => void) {
    this.lifetime.signal.throwIfAborted();
    guard();
  }
  private track<T>(run: () => Promise<T>) {
    const pending = run();
    this.pending.add(pending);
    return pending.finally(() => this.pending.delete(pending));
  }
  prepare(
    owner: string,
    input: McpChooseImport | McpScanImport | McpUploadedImport,
    context: McpOperationContext,
  ) {
    return this.track(async () => {
      this.check(context.assertAuthorized);
      await this.prune();
      const job = this.context(context);
      const prepared = await this.ports.prepare(input, job, owner);
      if (!prepared) return { status: "cancelled" };
      try {
        this.check(job.assertAuthorized);
        const pages = prepared.preview.chapters.flatMap(
          (chapter) => chapter.pages,
        );
        if (
          !pages.length ||
          pages.length > 500 ||
          prepared.preview.chapters.length > 10
        )
          throw new McpEditError(
            "invalid_edit",
            "Review one to ten chapters and at most five hundred candidate pages; no selection was truncated.",
          );
        const bytes = [...this.entries.values()].reduce(
          (sum, entry) => sum + entry.prepared.sourceBytes,
          0,
        );
        if (
          this.entries.size >= 10 ||
          bytes + prepared.sourceBytes > 256 * 1024 * 1024
        )
          throw new McpEditError(
            "editor_busy",
            "Import previews share a ten-preview/256-MiB source budget. Discard unused previews.",
          );
        const pageIds = prepared.preview.chapters.map((chapter) =>
          chapter.pages.map(() => randomUUID()),
        );
        const reference = McpImportPreviewReferenceSchema.parse({
          previewId: randomUUID(),
          snapshot: hashStableValue([
            prepared.evidence,
            prepared.preview,
            pageIds,
          ]),
          source: input.source,
          chapterCount: prepared.preview.chapters.length,
          pageCount: pages.length,
          sourceBytes: prepared.sourceBytes,
          expiresAt: this.ports.now() + 30 * 60_000,
          retention: "session-only",
        });
        this.entries.set(reference.previewId, {
          owner,
          prepared,
          reference,
          pageIds,
          busy: false,
          imported: false,
          ...(input.source === "web" ? { sourceUrl: input.url } : {}),
        });
        return { status: "prepared", importPreview: reference };
      } catch (error) {
        await prepared.cleanup();
        throw error;
      }
    });
  }
  async inspect(
    owner: string,
    input: {
      previewId: string;
      snapshot: string;
      offset: number;
      limit: number;
    },
    guard: () => void,
  ): Promise<
    ReturnType<typeof mcpLibraryImportOutputs.carrot_get_import_preview.parse>
  > {
    this.check(guard);
    await this.prune();
    const entry = this.owned(owner, input.previewId);
    this.assertSnapshot(entry, input.snapshot);
    const pages = entry.prepared.preview.chapters.flatMap((chapter, ci) =>
      chapter.pages.map((page, pi) => ({
        draftId: chapter.draftId,
        chapterTitle: chapter.title.slice(0, 240),
        sourceKind: chapter.sourceKind,
        pageId: entry.pageIds[ci][pi],
        name: page.name.slice(0, 260),
        pageIndex: pi,
      })),
    );
    this.check(guard);
    return {
      ...entry.reference,
      status: entry.imported ? "imported" : entry.busy || "ready",
      total: pages.length,
      offset: input.offset,
      limit: input.limit,
      nextOffset:
        input.offset + input.limit < pages.length
          ? input.offset + input.limit
          : null,
      pages: pages.slice(input.offset, input.offset + input.limit),
      warnings: entry.prepared.warnings,
    };
  }
  duplicates(owner: string, input: McpImportDuplicates, guard: () => void) {
    return this.track(() =>
      this.withSelection(
        owner,
        input,
        guard,
        async (request, _entries, verify) => {
          const result = await this.ports.duplicates(
            input.target,
            request.preview.chapters,
            () => this.check(guard),
          );
          await verify();
          return result;
        },
        "checking",
      ),
    );
  }
  reviewMapping(owner: string, input: McpImportPublication, guard: () => void) {
    return this.track(() =>
      this.withSelection(
        owner,
        input,
        guard,
        async (_request, _entries, verify, identities) => {
          const mapping = prepareMcpImageImportMapping(input, identities);
          await verify();
          return mapping.review;
        },
        "checking",
      ),
    );
  }
  create(
    owner: string,
    input: McpImportPublication,
    context: McpOperationContext,
  ) {
    return this.track(async () => {
      const job = this.context(context);
      job.assertAuthorized();
      const previous = await this.ports.find(owner, input);
      job.assertAuthorized();
      if (previous) return { status: "imported", importReceipt: previous };
      return this.withSelection(
        owner,
        input,
        job.assertAuthorized,
        async (request, entries, verify, identities) => {
          const mapping = prepareMcpImageImportMapping(input, identities);
          const receipt = await this.ports.commit(
            owner,
            input,
            request,
            entries[0].reference.source,
            verify,
            job,
            mapping,
          );
          for (const entry of entries) entry.imported = true;
          // Library publication succeeded. Temporary cleanup cannot reverse that fact.
          for (const entry of entries)
            await entry.prepared.cleanup().catch(this.ports.reportError);
          return { status: "imported", importReceipt: receipt };
        },
      );
    });
  }
  private async withSelection<T>(
    owner: string,
    input: McpImportSelection,
    guard: () => void,
    execute: (
      request: CreateImportFromPreviewRequest,
      entries: Entry[],
      verify: () => Promise<void>,
      identities: McpImportSourcePageIdentity[],
    ) => Promise<T>,
    operation: "checking" | "importing" = "importing",
  ) {
    this.check(guard);
    const entries = this.selectedEntries(owner, input);
    const request = selectMcpImport(entries, input);
    entries.forEach((entry) => {
      entry.busy = operation;
    });
    try {
      const verify = async () => {
        for (const entry of entries) {
          this.check(guard);
          this.owned(owner, entry.reference.previewId);
          await entry.prepared.verify();
        }
        this.check(guard);
      };
      await verify();
      const identified: ImportChapterDraft[] = [];
      const identities: McpImportSourcePageIdentity[] = [];
      for (const entry of entries) {
        const ids = new Set(
          entry.prepared.preview.chapters.map((chapter) => chapter.draftId),
        );
        identified.push(
          ...(await entry.prepared.identify(
            request.preview.chapters.filter((chapter) =>
              ids.has(chapter.draftId),
            ),
            () => this.check(guard),
            entry.sourceUrl,
            (identity) => identities.push(identity),
          )),
        );
      }
      request.preview.chapters = identified;
      await verify();
      return await execute(request, entries, verify, identities);
    } finally {
      entries.forEach((entry) => {
        entry.busy = false;
      });
    }
  }
  private selectedEntries(owner: string, input: McpImportSelection) {
    return importPublicationSelections(input).map((selection) => {
      const entry = this.owned(owner, selection.previewId);
      this.assertSnapshot(entry, selection.snapshot);
      if (entry.busy || entry.imported)
        throw new McpEditError(
          "invalid_edit",
          "This preview is in use or already imported. Inspect its original request receipt; do not import it twice.",
        );
      if ("items" in input && entry.reference.source !== "web")
        throw new McpEditError(
          "invalid_edit",
          "A URL batch can publish only its owned web previews.",
        );
      return entry;
    });
  }
  async discard(owner: string, previewId: string, guard: () => void) {
    this.check(guard);
    const entry = this.owned(owner, previewId);
    if (entry.busy)
      throw new McpEditError(
        "editor_busy",
        "Cancel and settle the import job before discarding its input.",
      );
    this.check(guard);
    await entry.prepared.cleanup();
    this.entries.delete(previewId);
    return {
      previewId,
      status: "discarded" as const,
      pagesChanged: 0 as const,
    };
  }
  stop() {
    this.lifetime.abort();
  }
  async close() {
    this.stop();
    await Promise.allSettled([...this.pending]);
    const entries = [...this.entries.values()];
    this.entries.clear();
    const results = await Promise.allSettled(
      entries.map((entry) => entry.prepared.cleanup()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Import preview cleanup failed.");
  }
  private context(context: McpOperationContext): McpOperationContext {
    const signal = AbortSignal.any([context.signal, this.lifetime.signal]);
    return {
      ...context,
      signal,
      assertAuthorized: () => {
        signal.throwIfAborted();
        this.check(context.assertAuthorized);
      },
    };
  }
  private owned(owner: string, id: string) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.owner !== owner ||
      entry.reference.expiresAt <= this.ports.now()
    )
      throw new McpEditError(
        "not_found",
        "Import preview is unavailable for this connection. Previews expire after thirty minutes or restart.",
      );
    return entry;
  }
  private assertSnapshot(entry: Entry, snapshot: string) {
    if (entry.reference.snapshot !== snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Import preview snapshot differs from the reviewed input.",
      );
  }
  private async prune() {
    for (const [id, entry] of this.entries) {
      if (entry.busy || entry.reference.expiresAt > this.ports.now()) continue;
      await entry.prepared.cleanup();
      this.entries.delete(id);
    }
  }
}
