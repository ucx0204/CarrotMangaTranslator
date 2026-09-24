import {
  McpContextMigrationPreviewSchema,
  type McpContextMigrationPreview,
} from "../../shared/mcpContextMigration";
import { type McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import { planMcpContextCatalogMigration } from "./mcpContextCatalogMigration";
import { prepareMcpContextMigration } from "./mcpContextMigrationPolicy";

type Plan = ReturnType<typeof planMcpContextCatalogMigration>;

/** No plan store or write port exists here: this is a repeatable read-only preview.
 * Future application must revalidate and publish context/references/history together. */
export class McpContextMigrationPreviewService {
  constructor(
    private readonly readWork: (
      chapterId: string,
      guard: () => void,
    ) => Promise<McpContextReferenceSnapshot>,
  ) {}

  async preview(input: McpContextMigrationPreview, guard: () => void) {
    guard();
    const request = McpContextMigrationPreviewSchema.parse(input);
    const graph = await this.readWork(request.chapterId, guard);
    const prepared = prepareMcpContextMigration(graph, request, guard);
    const planFingerprint = prepared.fingerprint;
    const plan = prepared.plan;
    guard();
    const total =
      request.section === "entries"
        ? plan.changes.length
        : plan.references.length;
    const end = request.offset + request.limit;
    return {
      workId: graph.workId,
      anchorChapterId: request.chapterId,
      referenceSnapshot: prepared.beforeSnapshot,
      planFingerprint,
      status: "preview_only" as const,
      section: request.section,
      total,
      offset: request.offset,
      limit: request.limit,
      nextOffset: end < total ? end : null,
      counts: describeImpact(plan),
      entries:
        request.section === "entries"
          ? plan.changes.slice(request.offset, end)
          : [],
      references:
        request.section === "references"
          ? plan.references.slice(request.offset, end)
          : [],
      pagesChanged: 0 as const,
      executable: false as const,
      note: "Read-only migration preview, not an executable proposal. Each reference row identifies an affected saved link, including duplicate and orphaned memory rows; no links have been changed or deduplicated. Manual and legacy entries are protected by default. Merge keeps destination fields; alias union runs only with copyAliases=true. Replacement keeps omitted protected entries in their original relative order after the supplied entries. No dialogue, story summary, digest, artwork, model or research result was changed. Applying and exact recovery use the separate native migration tools with this exact unfiltered snapshot and plan fingerprint.",
    };
  }
}

function describeImpact(plan: Plan) {
  const pages = new Set<string>();
  const memories = new Set<string>();
  const orphaned = new Set<string>();
  for (const reference of plan.references) {
    if (reference.memoryIndex === null) {
      pages.add(JSON.stringify([reference.chapterId, reference.pageId]));
    } else {
      const key = JSON.stringify([reference.chapterId, reference.memoryIndex]);
      memories.add(key);
      if (reference.orphanedMemory) orphaned.add(key);
    }
  }
  return {
    entriesAdded: plan.changes.filter((change) => change.operation === "added")
      .length,
    entriesUpdated: plan.changes.filter(
      (change) => change.operation === "updated",
    ).length,
    entriesRemoved: plan.changes.filter(
      (change) => change.operation === "removed",
    ).length,
    manualEntriesPreserved: plan.manualEntriesPreserved,
    referencesRemapped: plan.references.filter(
      (reference) => reference.toId !== null,
    ).length,
    referencesUnlinked: plan.references.filter(
      (reference) => reference.toId === null,
    ).length,
    pagesAffected: pages.size,
    memoryRowsAffected: memories.size,
    orphanedMemoryRowsAffected: orphaned.size,
    catalogOrderChanged: plan.catalogOrderChanged,
  };
}
