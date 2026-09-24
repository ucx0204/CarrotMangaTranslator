import { hashStableValue } from "../../shared/blockFingerprint";
import { restoreContextBlockReferences } from "../../shared/mcpContextMigrationState";
import type { McpChapterMoveIntent } from "../../shared/mcpChapterMove";
import type { LibraryChapter } from "../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";

type Kind = "glossary" | "character";
type Issue = {
  kind: Kind;
  sourceId: string;
  reason: "missing-target" | "different-definition" | "unused-mapping";
};

/** Moving is not a catalog merge. Unmapped references require identical destination definitions. */
export function planChapterMoveReferences(
  chapter: LibraryChapter,
  memory: ChapterStoryMemory | null,
  source: WorkStyleGuide,
  destination: WorkStyleGuide,
  mappings: NonNullable<McpChapterMoveIntent["references"]>,
) {
  const issues = new Map<string, Issue>();
  const used = new Set<string>();
  let mappedReferences = 0;
  const explicit = new Map(
    mappings.map((item) => [`${item.kind}/${item.sourceId}`, item.targetId]),
  );
  const catalogs = {
    glossary: {
      source: indexCatalog(source.glossary),
      destination: indexCatalog(destination.glossary),
    },
    character: {
      source: indexCatalog(source.characters),
      destination: indexCatalog(destination.characters),
    },
  };
  const resolve = (kind: Kind, sourceId: string) => {
    const key = `${kind}/${sourceId}`;
    used.add(key);
    const targetId = explicit.get(key) ?? sourceId;
    const target = catalogs[kind].destination.get(targetId);
    const reason = !target
      ? "missing-target"
      : !explicit.has(key) &&
          !sameDefinition(catalogs[kind].source.get(sourceId), target)
        ? "different-definition"
        : undefined;
    if (reason) issues.set(key, { kind, sourceId, reason });
    if (targetId !== sourceId) mappedReferences++;
    return targetId;
  };
  const next = structuredClone(chapter);
  for (const page of next.pages) {
    page.blocks = page.blocks.map((block) =>
      restoreContextBlockReferences(block, {
        ...(block.speakerId !== undefined
          ? { speakerId: resolve("character", block.speakerId) }
          : {}),
        ...(block.glossaryEntryIds !== undefined
          ? {
              glossaryEntryIds: block.glossaryEntryIds.map((id) =>
                resolve("glossary", id),
              ),
            }
          : {}),
      }),
    );
  }
  const nextMemory = mapMemoryReferences(memory, resolve);
  for (const item of mappings)
    if (!used.has(`${item.kind}/${item.sourceId}`))
      issues.set(`${item.kind}/${item.sourceId}`, {
        kind: item.kind,
        sourceId: item.sourceId,
        reason: "unused-mapping",
      });
  if (used.size > 2000 || issues.size > 2000)
    throw new Error(
      "Chapter movement exceeds the bounded reference inventory.",
    );
  return {
    chapter: next,
    memory: nextMemory,
    issues: [...issues.values()],
    mappedReferences,
  };
}

function indexCatalog<T extends { id: string }>(entries: T[]) {
  const map = new Map(entries.map((entry) => [entry.id, entry]));
  if (map.size !== entries.length)
    throw new Error("A work catalog contains duplicate IDs.");
  return map;
}
function sameDefinition(source: object | undefined, target: object) {
  if (!source) return false;
  const substantive = (entry: object) =>
    Object.fromEntries(
      Object.entries(entry).filter(
        ([key]) => key !== "createdAt" && key !== "updatedAt",
      ),
    );
  return (
    hashStableValue(substantive(source)) ===
    hashStableValue(substantive(target))
  );
}

function mapMemoryReferences(
  memory: ChapterStoryMemory | null,
  resolve: (kind: Kind, id: string) => string,
) {
  const nextMemory = memory ? structuredClone(memory) : null;
  for (const row of nextMemory?.pages ?? []) {
    if (row.glossaryEntryIds)
      row.glossaryEntryIds = row.glossaryEntryIds.map((id) =>
        resolve("glossary", id),
      );
    if (row.characterIds)
      row.characterIds = row.characterIds.map((id) => resolve("character", id));
  }
  return nextMemory;
}
