import { hashStableValue } from "../../shared/blockFingerprint";
import {
  WorkStyleGuideSchema,
  ChapterStoryMemorySchema,
} from "../../shared/ipcWorkContextSchemas";
import {
  McpContextMigrationPreviewSchema,
  type McpContextMigrationPreview,
} from "../../shared/mcpContextMigration";
import {
  McpContextReferencesSchema,
  type McpContextReferenceSnapshot,
} from "../../shared/mcpContextReferences";
import {
  contextBlockReferences,
  restoreContextBlockReferences,
  ContextMigrationDeltaSchema,
  type ContextMigrationDelta,
} from "../../shared/mcpContextMigrationState";
import type { TranslationBlock } from "../../shared/textTypes";
import type { ChapterStoryMemory } from "../../shared/workContextTypes";
import { inspectMcpContextReferenceGraph } from "./mcpContextReferenceService";
import { planMcpContextCatalogMigration } from "./mcpContextCatalogMigration";
import { McpEditError } from "./mcpEditPolicy";

type Graph = McpContextReferenceSnapshot;
type Intent = Pick<
  McpContextMigrationPreview,
  | "chapterId"
  | "referenceSnapshot"
  | "command"
  | "preserveManual"
  | "planFingerprint"
>;
type CatalogPlan = ReturnType<typeof planMcpContextCatalogMigration>;

export function contextMigrationSnapshot(
  graph: Graph,
  chapterId: string,
  guard: () => void,
) {
  return inspectMcpContextReferenceGraph(
    graph,
    McpContextReferencesSchema.parse({ chapterId }),
    guard,
  );
}
export function prepareMcpContextMigration(
  graph: Graph,
  input: Intent,
  guard: () => void,
) {
  const request = McpContextMigrationPreviewSchema.parse({
    chapterId: input.chapterId,
    referenceSnapshot: input.referenceSnapshot,
    command: input.command,
    preserveManual: input.preserveManual,
    planFingerprint: input.planFingerprint,
  });
  const observed = contextMigrationSnapshot(graph, request.chapterId, guard);
  if (request.referenceSnapshot !== observed.snapshot)
    throw new McpEditError(
      "revision_conflict",
      "Read an unfiltered whole-work reference snapshot before migration; saved context or another chapter changed.",
    );
  const fingerprint = hashStableValue({
    referenceSnapshot: observed.snapshot,
    command: request.command,
    preserveManual: request.preserveManual,
  });
  if (request.planFingerprint && request.planFingerprint !== fingerprint)
    throw new McpEditError(
      "revision_conflict",
      "Migration intent changed. Restart preview pagination.",
    );
  const plan = planMcpContextCatalogMigration(
    graph.styleGuide,
    request.command,
    request.preserveManual,
    observed.references,
  );
  guard();
  return { request, plan, fingerprint, beforeSnapshot: observed.snapshot };
}

/** Computes native data changes only. No file/model/state mutation occurs here. */
export function createMcpContextMigrationDelta(
  graph: Graph,
  prepared: ReturnType<typeof prepareMcpContextMigration>,
  now: string,
  guard: () => void,
) {
  const { plan, request } = prepared;
  const next = structuredClone(graph);
  const delta: ContextMigrationDelta = { pages: [], memories: [] };
  if (plan.changes.length || plan.catalogOrderChanged) {
    next.styleGuide = migrateGuide(graph, plan, now);
    delta.guide = {
      before: structuredClone(graph.styleGuide),
      after: next.styleGuide,
    };
  }
  for (const [index, item] of next.chapters.entries()) {
    guard();
    migrateChapterBlocks(item, plan, delta);
    const memory = migrateMemory(item.storyMemory, plan, now);
    if (hashStableValue(memory) !== hashStableValue(item.storyMemory)) {
      delta.memories.push({
        chapterId: item.chapter.id,
        before: graph.chapters[index].storyMemory,
        after: memory,
      });
      item.storyMemory = memory;
    }
  }
  ContextMigrationDeltaSchema.parse(delta);
  const afterSnapshot = contextMigrationSnapshot(
    next,
    request.chapterId,
    guard,
  ).snapshot;
  return { delta, beforeSnapshot: prepared.beforeSnapshot, afterSnapshot };
}

function migrateGuide(graph: Graph, plan: CatalogPlan, now: string) {
  const original =
    plan.entity === "glossary"
      ? graph.styleGuide.glossary
      : graph.styleGuide.characters;
  const existing = new Map(original.map((entry) => [entry.id, entry]));
  const changed = new Set(plan.changes.map((entry) => entry.entryId));
  const entries = plan.catalog.map((fields) => {
    const before = existing.get(fields.id);
    if (before && !changed.has(fields.id)) return structuredClone(before);
    const metadata = before
      ? {
          createdAt: before.createdAt,
          updatedAt: now,
          ...(before.origin !== undefined ? { origin: before.origin } : {}),
        }
      : { createdAt: now, updatedAt: now, origin: "manual" as const };
    return { ...structuredClone(fields), ...metadata };
  });
  return WorkStyleGuideSchema.parse({
    ...graph.styleGuide,
    [plan.entity === "glossary" ? "glossary" : "characters"]: entries,
    updatedAt: now,
  });
}

function migrateChapterBlocks(
  item: Graph["chapters"][number],
  plan: CatalogPlan,
  delta: ContextMigrationDelta,
) {
  for (const page of item.chapter.pages) {
    const blocks: ContextMigrationDelta["pages"][number]["blocks"] = [];
    page.blocks = page.blocks.map((block) => {
      const before = contextBlockReferences(block);
      const after = migrateBlockReferences(block, plan);
      if (hashStableValue(before) === hashStableValue(after)) return block;
      blocks.push({ blockId: block.id, before, after });
      return restoreContextBlockReferences(block, after);
    });
    if (blocks.length)
      delta.pages.push({ chapterId: item.chapter.id, pageId: page.id, blocks });
  }
}

function migrateBlockReferences(block: TranslationBlock, plan: CatalogPlan) {
  const after = contextBlockReferences(block);
  if (
    plan.entity === "character" &&
    after.speakerId !== undefined &&
    plan.mappings.has(after.speakerId)
  ) {
    const target = plan.mappings.get(after.speakerId);
    if (target === null) delete after.speakerId;
    else if (target !== undefined) after.speakerId = target;
  }
  if (plan.entity === "glossary" && after.glossaryEntryIds !== undefined)
    after.glossaryEntryIds = remapIds(after.glossaryEntryIds, plan.mappings);
  return after;
}

function migrateMemory(
  before: ChapterStoryMemory,
  plan: CatalogPlan,
  now: string,
) {
  const after = structuredClone(before);
  const key = plan.entity === "character" ? "characterIds" : "glossaryEntryIds";
  for (const memory of after.pages) {
    const ids = memory[key];
    if (ids === undefined) continue;
    const next = remapIds(ids, plan.mappings);
    if (hashStableValue(ids) === hashStableValue(next)) continue;
    memory[key] = next;
    memory.updatedAt = now;
    after.updatedAt = now;
  }
  return ChapterStoryMemorySchema.parse(after);
}

/** Coalesce only mapped destination identities. Unrelated duplicate links stay untouched. */
function remapIds(
  ids: string[],
  mappings: Map<string, string | null>,
): string[] {
  if (!ids.some((id) => mappings.has(id))) return ids;
  const destinations = new Set(
    [...mappings.values()].filter((id) => id !== null),
  );
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const next = mappings.has(id) ? mappings.get(id) : id;
    if (next === null || next === undefined) continue;
    if (destinations.has(next) && seen.has(next)) continue;
    result.push(next);
    seen.add(next);
  }
  return result;
}

export function contextMigrationDeltaCounts(delta: ContextMigrationDelta) {
  return {
    guideChanged: Boolean(delta.guide),
    pages: delta.pages.length,
    blocks: delta.pages.reduce((total, page) => total + page.blocks.length, 0),
    memories: delta.memories.length,
  };
}
