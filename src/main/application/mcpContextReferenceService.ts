import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision } from "../../shared/pageRevision";
import { mcpContextRevision } from "../../shared/mcpContextEditing";
import {
  MCP_CONTEXT_GRAPH_BLOCKS,
  MCP_CONTEXT_GRAPH_CHAPTERS,
  MCP_CONTEXT_GRAPH_PAGES,
  MCP_CONTEXT_GRAPH_REFERENCES,
  McpContextReferencesSchema,
  type McpContextReference,
  type McpContextReferenceSnapshot,
  type McpContextReferences,
} from "../../shared/mcpContextReferences";
import { McpEditError } from "./mcpEditPolicy";

type Catalog = Map<string, Array<{ enabled: boolean }>>;
type Counts = {
  chapters: number;
  pages: number;
  blocks: number;
  memories: number;
  references: number;
  active: number;
  disabled: number;
  missing: number;
  ambiguous: number;
  duplicateReferences: number;
  orphanedMemories: number;
  duplicateMemories: number;
};
type Collection = {
  references: McpContextReference[];
  counts: Counts;
  characters: Catalog;
  glossary: Catalog;
};
type Chapter = McpContextReferenceSnapshot["chapters"][number];

/** Read-only impact inventory. Names are never inferred to be the same identity. */
export class McpContextReferenceService {
  constructor(
    private readonly readWork: (
      chapterId: string,
      guard: () => void,
    ) => Promise<McpContextReferenceSnapshot>,
  ) {}

  async inspect(input: McpContextReferences, guard: () => void) {
    const request = McpContextReferencesSchema.parse(input);
    guard();
    const graph = await this.readWork(request.chapterId, guard);
    const collection = inspectMcpContextReferenceGraph(graph, request, guard);
    const snapshot = collection.snapshot;
    if (request.snapshot && request.snapshot !== snapshot)
      throw new McpEditError(
        "revision_conflict",
        "Work context or reference selection changed. Restart pagination.",
      );
    const selectedIds = request.entryIds ? new Set(request.entryIds) : null;
    const references = collection.references.filter(
      (item) =>
        (!request.entity || request.entity === item.entity) &&
        (!selectedIds || selectedIds.has(item.entryId)) &&
        (!request.issuesOnly ||
          item.status !== "active" ||
          item.duplicate ||
          item.orphanedMemory),
    );
    guard();
    return {
      workId: graph.workId,
      anchorChapterId: request.chapterId,
      snapshot,
      total: references.length,
      offset: request.offset,
      limit: request.limit,
      nextOffset:
        request.offset + request.limit < references.length
          ? request.offset + request.limit
          : null,
      counts: collection.counts,
      references: references.slice(
        request.offset,
        request.offset + request.limit,
      ),
      pagesChanged: 0 as const,
      note: "Saved references across all chapters of this work, including orphaned memory rows. Counts cover the whole work; filters affect the reference list only. No merge, deletion, translation, research or memory freshness certification was performed.",
    };
  }
}

/** Native-only graph validation and complete collection shared by inspection and planning. */
export function inspectMcpContextReferenceGraph(
  graph: McpContextReferenceSnapshot,
  request: McpContextReferences,
  guard: () => void,
) {
  guard();
  assertGraph(graph, request.chapterId);
  const collection = collectReferences(graph, guard);
  const snapshot = graphFingerprint(graph, request);
  guard();
  return {
    references: collection.references,
    counts: collection.counts,
    snapshot,
  };
}

function assertGraph(graph: McpContextReferenceSnapshot, anchor: string) {
  if (
    graph.styleGuide.workId !== graph.workId ||
    !graph.chapters.some(({ chapter }) => chapter.id === anchor)
  )
    throw new McpEditError(
      "not_found",
      "The anchor does not belong to this work context.",
    );
  if (
    graph.chapters.length > MCP_CONTEXT_GRAPH_CHAPTERS ||
    new Set(graph.chapters.map(({ chapter }) => chapter.id)).size !==
      graph.chapters.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Work chapters exceed the inspection limit or contain duplicate IDs.",
    );
  for (const item of graph.chapters) assertChapter(item, graph.workId);
}

function assertChapter({ chapter, storyMemory }: Chapter, workId: string) {
  if (
    chapter.workId !== workId ||
    storyMemory.workId !== workId ||
    storyMemory.chapterId !== chapter.id
  )
    throw new McpEditError(
      "revision_conflict",
      "A chapter or memory changed work membership.",
    );
  if (
    new Set(chapter.pages.map((page) => page.id)).size !== chapter.pages.length
  )
    throw new McpEditError(
      "invalid_edit",
      "Duplicate saved page IDs cannot be inspected as distinct pages.",
    );
  for (const page of chapter.pages)
    if (
      new Set(page.blocks.map((block) => block.id)).size !== page.blocks.length
    )
      throw new McpEditError(
        "invalid_edit",
        "Duplicate saved block IDs cannot identify distinct references.",
      );
}

function graphFingerprint(
  graph: McpContextReferenceSnapshot,
  request: McpContextReferences,
) {
  return hashStableValue({
    anchor: request.chapterId,
    entity: request.entity ?? null,
    entryIds: request.entryIds ? [...request.entryIds].sort() : null,
    issuesOnly: request.issuesOnly,
    chapters: graph.chapters.map(({ chapter, storyMemory }) => ({
      id: chapter.id,
      context: mcpContextRevision({ ...graph, storyMemory }),
      order: chapter.pageOrder,
      pages: chapter.pages.map((page) => [page.id, createPageRevision(page)]),
    })),
  });
}

function catalog(entries: Array<{ id: string; enabled: boolean }>): Catalog {
  const result: Catalog = new Map();
  for (const entry of entries) {
    const previous = result.get(entry.id) ?? [];
    previous.push(entry);
    result.set(entry.id, previous);
  }
  return result;
}

function collectReferences(
  graph: McpContextReferenceSnapshot,
  guard: () => void,
) {
  const collection: Collection = {
    references: [],
    characters: catalog(graph.styleGuide.characters),
    glossary: catalog(graph.styleGuide.glossary),
    counts: {
      chapters: graph.chapters.length,
      pages: 0,
      blocks: 0,
      memories: 0,
      references: 0,
      active: 0,
      disabled: 0,
      missing: 0,
      ambiguous: 0,
      duplicateReferences: 0,
      orphanedMemories: 0,
      duplicateMemories: 0,
    },
  };
  for (const item of graph.chapters) {
    collection.counts.pages += item.chapter.pages.length;
    collection.counts.memories += item.storyMemory.pages.length;
    checkSize(collection);
    collectBlockReferences(collection, item.chapter, guard);
    collectMemoryReferences(collection, item, guard);
  }
  return collection;
}

function collectBlockReferences(
  collection: Collection,
  chapter: Chapter["chapter"],
  guard: () => void,
) {
  for (const page of chapter.pages) {
    guard();
    collection.counts.blocks += page.blocks.length;
    checkSize(collection);
    for (const block of page.blocks) {
      const location = {
        chapterId: chapter.id,
        pageId: page.id,
        blockId: block.id,
        memoryIndex: null,
        orphanedMemory: false,
      };
      if (block.speakerId !== undefined)
        addReferences(collection, location, "block-speaker", [block.speakerId]);
      addReferences(
        collection,
        location,
        "block-glossary",
        block.glossaryEntryIds ?? [],
      );
    }
  }
}

function collectMemoryReferences(
  collection: Collection,
  { chapter, storyMemory }: Chapter,
  guard: () => void,
) {
  const pageIds = new Set(chapter.pages.map((page) => page.id));
  const seenMemories = new Set<string>();
  for (const [memoryIndex, memory] of storyMemory.pages.entries()) {
    guard();
    const orphanedMemory = !pageIds.has(memory.pageId);
    if (orphanedMemory) collection.counts.orphanedMemories++;
    if (seenMemories.has(memory.pageId)) collection.counts.duplicateMemories++;
    seenMemories.add(memory.pageId);
    const location = {
      chapterId: chapter.id,
      pageId: memory.pageId,
      blockId: null,
      memoryIndex,
      orphanedMemory,
    };
    addReferences(
      collection,
      location,
      "memory-character",
      memory.characterIds ?? [],
    );
    addReferences(
      collection,
      location,
      "memory-glossary",
      memory.glossaryEntryIds ?? [],
    );
  }
}

function checkSize(collection: Collection) {
  if (
    collection.counts.pages > MCP_CONTEXT_GRAPH_PAGES ||
    collection.counts.blocks > MCP_CONTEXT_GRAPH_BLOCKS ||
    collection.counts.memories > MCP_CONTEXT_GRAPH_REFERENCES
  )
    throw new McpEditError(
      "invalid_edit",
      "Work reference inspection exceeds its bounded snapshot budget. No partial inventory was returned.",
    );
}

function addReferences(
  collection: Collection,
  location: Pick<
    McpContextReference,
    "chapterId" | "pageId" | "blockId" | "memoryIndex" | "orphanedMemory"
  >,
  kind: McpContextReference["kind"],
  ids: string[],
) {
  const entity =
    kind === "block-speaker" || kind === "memory-character"
      ? "character"
      : "glossary";
  const entries =
    entity === "character" ? collection.characters : collection.glossary;
  const seen = new Set<string>();
  for (const entryId of ids) {
    if (collection.references.length >= MCP_CONTEXT_GRAPH_REFERENCES)
      throw new McpEditError(
        "invalid_edit",
        "Too many work references; no partial inventory was returned.",
      );
    const matches = entries.get(entryId) ?? [];
    const status =
      matches.length > 1
        ? "ambiguous"
        : matches.length === 0
          ? "missing"
          : matches[0].enabled
            ? "active"
            : "disabled";
    const duplicate = seen.has(entryId);
    seen.add(entryId);
    collection.references.push({
      ...location,
      kind,
      entity,
      entryId,
      status,
      duplicate,
    });
    collection.counts.references++;
    collection.counts[status]++;
    if (duplicate) collection.counts.duplicateReferences++;
  }
}
