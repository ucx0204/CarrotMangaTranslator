import {
  McpImportPageMappingSchema,
  McpImportPublicationMetadataSchema,
  matchesMcpImportPageMapping,
} from "../../shared/mcpImportMapping";
import type { McpPreparedImportMapping } from "../application/mcpImportMappingPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import type {
  NativeImportedPageEvidence,
  NativeImportMetadataEvidence,
} from "../libraryStore/importPublicationEvidence";

/** Collects only actual native materialization callbacks inside one import transaction. */
export class McpImportMappingPublication {
  private readonly observed: NativeImportedPageEvidence[] = [];
  private readonly verifiers: (() => Promise<void>)[] = [];
  private work?: Extract<NativeImportMetadataEvidence, { kind: "work" }>;
  private guide?: Extract<NativeImportMetadataEvidence, { kind: "work-guide" }>;
  private readonly chapters: Array<
    Extract<NativeImportMetadataEvidence, { kind: "chapter" }>
  > = [];
  constructor(private readonly plan: McpPreparedImportMapping) {}
  readonly observePage = (
    evidence: NativeImportedPageEvidence,
    verify: () => Promise<void>,
  ) => {
    const expected = this.plan.items[this.observed.length];
    const source = evidence.source;
    if (
      !expected ||
      source.kind !== this.plan.kind ||
      source.chapterId !== expected.sourceChapterId ||
      source.pageIndex !== expected.pageIndex ||
      source.pageId !== expected.sourcePageId ||
      (expected.source &&
        (source.bytes !== expected.source.bytes ||
          source.sha256 !== expected.source.sha256))
    )
      throw new McpEditError(
        "revision_conflict",
        "Native imported page differs from the exact reviewed source selection.",
      );
    this.observed.push(structuredClone(evidence));
    this.verifiers.push(verify);
  };
  readonly observeMetadata = (
    evidence: NativeImportMetadataEvidence,
    verify: () => Promise<void>,
  ) => {
    if (evidence.kind === "work") {
      if (this.work)
        throw new McpEditError(
          "revision_conflict",
          "Native import emitted duplicate work metadata.",
        );
      this.work = structuredClone(evidence);
    } else if (evidence.kind === "work-guide") {
      if (this.guide)
        throw new McpEditError(
          "revision_conflict",
          "Native import emitted duplicate work guide evidence.",
        );
      this.guide = structuredClone(evidence);
    } else {
      if (
        this.chapters.length >= this.plan.review.maxChapters ||
        this.chapters.some(
          (chapter) => chapter.chapterId === evidence.chapterId,
        )
      )
        throw new McpEditError(
          "revision_conflict",
          "Native import emitted extra or duplicate chapter metadata.",
        );
      this.chapters.push(structuredClone(evidence));
    }
    this.verifiers.push(verify);
  };
  async verify() {
    for (const verify of this.verifiers) await verify();
  }
  finish(result: { workId: string; chapterIds: string[] }) {
    if (this.observed.length !== this.plan.items.length)
      throw new McpEditError(
        "revision_conflict",
        "Native import did not materialize every reviewed page exactly once.",
      );
    const mapping = McpImportPageMappingSchema.parse({
      version: 1,
      selectionFingerprint: this.plan.review.selectionFingerprint,
      ...(this.plan.sourceArchiveSha256
        ? { sourceArchiveSha256: this.plan.sourceArchiveSha256 }
        : {}),
      chapterPageCounts: Array.from(
        { length: this.plan.review.maxChapters },
        (_, index) =>
          this.plan.items.filter((item) => item.chapterIndex === index).length,
      ),
      publication: this.publication(result),
      items: this.observed.map((observed, index) => {
        const expected = this.plan.items[index];
        return {
          itemKey: expected.itemKey,
          chapterIndex: expected.chapterIndex,
          pageIndex: expected.pageIndex,
          source: {
            bytes: observed.source.bytes,
            sha256: observed.source.sha256,
            format: observed.source.format,
          },
          original: observed.original,
          page: observed.page,
        };
      }),
    });
    if (
      !matchesMcpImportPageMapping({
        ...result,
        pageCount: this.plan.items.length,
        pageMapping: mapping,
      })
    )
      throw new McpEditError(
        "revision_conflict",
        "Native saved page IDs do not match the published chapter transaction.",
      );
    return mapping;
  }
  private publication(result: { workId: string; chapterIds: string[] }) {
    if (
      !this.work ||
      this.work.workId !== result.workId ||
      !this.guide ||
      this.guide.workId !== result.workId ||
      this.chapters.length !== result.chapterIds.length ||
      this.chapters.some(
        (chapter, index) =>
          chapter.workId !== result.workId ||
          chapter.chapterId !== result.chapterIds[index],
      )
    )
      throw new McpEditError(
        "revision_conflict",
        "Native import publication lacks its exact work, guide and complete ordered chapter metadata.",
      );
    return McpImportPublicationMetadataSchema.parse({
      workId: result.workId,
      workSha256: this.work.sha256,
      guideSha256: this.guide.sha256,
      chapters: this.chapters.map(({ chapterId, sha256, memorySha256 }) => ({
        chapterId,
        sha256,
        memorySha256,
      })),
    });
  }
}
