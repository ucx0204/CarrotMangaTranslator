import { randomUUID } from "node:crypto";
import { tMain } from "../libraryStore/localization";
import { join } from "node:path";
import {
  ChapterSnapshotSchema,
  LibraryChapterFileSchema,
  LibraryWorkFileSchema,
  StoredLibraryIndexFileSchema,
} from "../../shared/ipcLibrarySchemas";
import {
  ChapterStoryMemorySchema,
  WorkStyleGuideSchema,
} from "../../shared/ipcWorkContextSchemas";
import type { RecoveredWork } from "../../shared/environmentBackup";
import { parseWorkGlossaryFile } from "../../shared/workGlossaryFile";
import {
  applyWorkGlossaryImport,
  planWorkGlossaryImport,
} from "../../shared/workGlossaryImportPlan";
import { createUnpublishedWork } from "../libraryStore/libraryFiles";
import { createDefaultWorkStyleGuide } from "../libraryStore/workContextFiles";
import { resolveChapterStatus } from "../libraryStore/chapterRecords";
import { writeJsonFile } from "../libraryStore/storage";
import { readBackupJson } from "./files";
import { salvageChapterPages, type RecoverySource } from "./salvagePages";

async function document(source: RecoverySource, path: string) {
  if (!source.files.has(path)) return;
  try {
    return await readBackupJson(join(source.root, path));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    source.report(path);
  }
}
function ordered<T>(map: Map<string, T>, ids: string[] = []) {
  const entries: [string, T][] = [];
  for (const id of new Set([...ids, ...map.keys()])) {
    const value = map.get(id);
    if (value !== undefined) entries.push([id, value]);
  }
  return entries;
}

export async function prepareRecoveredWorks(
  source: RecoverySource,
  stage: string,
  libraryDir: string,
) {
  const groups = groupLibraryFiles(source.files);
  const index = StoredLibraryIndexFileSchema.safeParse(
    await document(source, "library/index.json"),
  ).data;
  const items: RecoveredWork[] = [];
  for (const [id, chapters] of ordered(groups, index?.workOrder)) {
    source.signal.throwIfAborted();
    const work = await prepareWork(source, id, chapters, stage, libraryDir);
    if (work) items.push(work);
  }
  return items;
}

function groupLibraryFiles(files: Set<string>) {
  const groups = new Map<string, Map<string, string[]>>();
  for (const path of files) {
    const parts = path.split("/");
    const [, works, id, child, chapterId, dir] = parts;
    if (works !== "works" || !child || id.startsWith(".")) continue;
    const chapters = groups.get(id) ?? new Map<string, string[]>();
    groups.set(id, chapters);
    if (child !== "chapters" || !chapterId || chapterId.startsWith("."))
      continue;
    const originals = chapters.get(chapterId) ?? [];
    if (dir === "pages" && parts.length === 7) originals.push(path);
    chapters.set(chapterId, originals);
  }

  return groups;
}

async function recoveredWorkHeader(
  source: RecoverySource,
  prefix: string,
  id: string,
) {
  const raw = LibraryWorkFileSchema.safeParse(
    await document(source, prefix + "/work.json"),
  ).data;
  const saved = raw?.id === id ? raw : undefined;
  if (!saved || !ChapterSnapshotSchema.shape.workId.safeParse(id).success)
    source.report(prefix + "/work.json");
  const work = createUnpublishedWork(
    saved?.title || tMain("backup.recoveredWork", { id: id.slice(0, 36) }),
  );
  work.readingDirection = saved?.readingDirection ?? "auto";

  return { work, order: saved?.chapterOrder ?? [] };
}

async function prepareWork(
  source: RecoverySource,
  id: string,
  chapters: Map<string, string[]>,
  stage: string,
  libraryDir: string,
) {
  const prefix = "library/works/" + id;
  const { work, order } = await recoveredWorkHeader(source, prefix, id);
  const written = join(stage, work.id),
    published = join(libraryDir, "works", work.id);
  const guide = await recoverGuide(source, prefix, work.id);
  let pages = 0;
  for (const missing of order) {
    if (!chapters.has(missing))
      source.report(prefix + "/chapters/" + missing + "/chapter.json");
  }
  for (const [chapter, originals] of ordered(chapters, order)) {
    source.signal.throwIfAborted();
    const restored = await prepareChapter(
      source,
      { workId: id, chapterId: chapter, originals },
      { workId: work.id, written, published },
    );
    if (!restored) continue;
    pages += restored.pages.length;
    work.chapterOrder.push(restored.id);
  }
  if (!work.chapterOrder.length && !guide) return;
  await writeJsonFile(join(written, "work.json"), work);
  if (guide) await writeJsonFile(join(written, "style-guide.json"), guide);
  return {
    sourceId: work.id,
    title: work.title,
    chapters: work.chapterOrder.length,
    pages,
    terms: guide ? guide.glossary.length + guide.characters.length : 0,
    sample:
      guide && !work.chapterOrder.length
        ? [
            ...guide.glossary
              .slice(0, 3)
              .map((entry) =>
                [entry.source, entry.target].filter(Boolean).join(" → "),
              ),
            ...guide.characters
              .slice(0, 3)
              .map((entry) => entry.displayName || entry.targetName),
          ].slice(0, 3)
        : undefined,
  };
}

async function recoverGuide(
  source: RecoverySource,
  prefix: string,
  id: string,
) {
  const path = prefix + "/style-guide.json";
  const raw = await document(source, path);
  if (!raw) return;
  const full = WorkStyleGuideSchema.safeParse(raw).data;
  if (full && full.workId === prefix.split("/").at(-1))
    return { ...full, workId: id };
  // Unlike a native guide, old portable term files have no workId.
  if (
    typeof raw === "object" &&
    "workId" in raw &&
    raw.workId !== prefix.split("/").at(-1)
  ) {
    source.report(path);
    return;
  }
  const parsed = parseWorkGlossaryFile(JSON.stringify(raw));
  if (!parsed.ok) {
    source.report(path);
    return;
  }
  const guide = createDefaultWorkStyleGuide(id);
  if (parsed.file.invalidCount) source.report(path);
  return applyWorkGlossaryImport(
    guide,
    planWorkGlossaryImport(guide, parsed.file),
    "keep-existing",
    { now: guide.createdAt, createId: () => randomUUID() },
  ).guide;
}

async function readChapterSource(
  source: RecoverySource,
  prefix: string,
  from: { workId: string; chapterId: string },
) {
  const path = prefix + "/chapter.json";
  const raw = await document(source, path);
  const body =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bound = body.id === from.chapterId && body.workId === from.workId;
  const head = bound
    ? LibraryChapterFileSchema.safeParse({ ...body, pageOrder: [], pages: [] })
        .data
    : undefined;
  if (
    !head ||
    !ChapterSnapshotSchema.shape.id.safeParse(from.chapterId).success
  )
    source.report(path);
  const rawPages = bound && Array.isArray(body.pages) ? body.pages : [];
  const order =
    bound && Array.isArray(body.pageOrder)
      ? body.pageOrder.filter((v): v is string => typeof v === "string")
      : [];

  return { head, rawPages, order };
}

async function prepareChapter(
  source: RecoverySource,
  from: { workId: string; chapterId: string; originals: string[] },
  to: { workId: string; written: string; published: string },
) {
  const prefix = "library/works/" + from.workId + "/chapters/" + from.chapterId;
  const { head, rawPages, order } = await readChapterSource(
    source,
    prefix,
    from,
  );
  const chapterId = randomUUID();
  const written = join(to.written, "chapters", chapterId);
  const { pages, pageIds } = await salvageChapterPages({
    source,
    prefix,
    written,
    published: join(to.published, "chapters", chapterId),
    originals: from.originals.sort((a, b) =>
      a.localeCompare(b, "en", { numeric: true }),
    ),
    rawPages,
    order,
  });
  if (!pages.length) return;
  const now = new Date().toISOString();
  const chapter = LibraryChapterFileSchema.parse({
    id: chapterId,
    workId: to.workId,
    title: head?.title ?? from.chapterId.slice(0, 200),
    sourceKind: head?.sourceKind ?? "images",
    status: resolveChapterStatus(pages),
    pageOrder: pages.map((p) => p.id),
    pages,
    createdAt: head?.createdAt ?? now,
    updatedAt: now,
  });
  await writeJsonFile(join(written, "chapter.json"), chapter);
  await recoverStoryMemory(source, prefix, from, written, chapter, pageIds);
  return chapter;
}

async function recoverStoryMemory(
  source: RecoverySource,
  prefix: string,
  from: { workId: string; chapterId: string },
  written: string,
  chapter: import("../../shared/libraryTypes").LibraryChapter,
  pageIds: Map<string, string>,
) {
  const memoryPath = prefix + "/story-memory.json";
  const memory = ChapterStoryMemorySchema.safeParse(
    await document(source, memoryPath),
  ).data;
  if (memory?.chapterId === from.chapterId && memory.workId === from.workId) {
    const positions = new Map(chapter.pageOrder.map((id, i) => [id, i]));
    const entries = memory.pages.flatMap((entry) => {
      const id = pageIds.get(entry.pageId);
      const pageIndex = id ? positions.get(id) : undefined;
      return id && pageIndex !== undefined
        ? [{ ...entry, pageId: id, pageIndex }]
        : [];
    });
    await writeJsonFile(join(written, "story-memory.json"), {
      ...memory,
      workId: chapter.workId,
      chapterId: chapter.id,
      pages: entries,
    });
  }
}
