import { join } from "node:path";
import type { z } from "zod";
import {
  ChapterStoryMemorySchema,
  WorkStyleGuideSchema,
} from "../../shared/ipcSchemas";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import {
  WORKS_ROOT,
  findChapterLocation,
  readChapterFile,
  readWorkFile,
} from "./libraryFiles";
import { readJsonFile, writeJsonFile } from "./storage";
import { reconcilePageStoryMemories } from "./storyMemoryReconcile";
import { reorderRecords } from "./chapterRecords";

function createDefaultWorkStyleGuide(workId: string): WorkStyleGuide {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    workId,
    glossary: [],
    characters: [],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function createDefaultChapterStoryMemory(
  workId: string,
  chapterId: string,
): ChapterStoryMemory {
  return {
    schemaVersion: 1,
    workId,
    chapterId,
    pages: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function readWorkStyleGuide(
  workId: string,
): Promise<WorkStyleGuide> {
  await ensureWorkExists(workId);
  const raw = await readOptionalContextJson(
    styleGuidePath(workId),
    "style-guide.json",
  );
  if (!raw) {
    return createDefaultWorkStyleGuide(workId);
  }
  const guide = parseStoredContext(
    WorkStyleGuideSchema,
    raw,
    "style-guide.json",
  );
  if (guide.workId !== workId) {
    throw new Error("작품 용어집의 보관함 위치가 올바르지 않습니다.");
  }
  return guide;
}

export async function writeWorkStyleGuide(
  guide: WorkStyleGuide,
): Promise<WorkStyleGuide> {
  await ensureWorkExists(guide.workId);
  const checked = parseStoredContext(
    WorkStyleGuideSchema,
    {
      ...guide,
      updatedAt: new Date().toISOString(),
    },
    "style-guide.json",
  );
  await writeJsonFile(styleGuidePath(checked.workId), checked);
  return checked;
}

export async function readChapterStoryMemory(
  chapterId: string,
): Promise<ChapterStoryMemory> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("스토리 메모리를 읽을 화를 찾지 못했습니다.");
  }
  const raw = await readOptionalContextJson(
    storyMemoryPath(locator.workId, locator.chapterId),
    "story-memory.json",
  );
  if (!raw) {
    return createDefaultChapterStoryMemory(locator.workId, locator.chapterId);
  }
  const memory = parseStoredContext(
    ChapterStoryMemorySchema,
    raw,
    "story-memory.json",
  );
  if (
    memory.workId !== locator.workId ||
    memory.chapterId !== locator.chapterId
  ) {
    throw new Error("스토리 메모리의 보관함 위치가 올바르지 않습니다.");
  }
  return memory;
}

export async function writeChapterStoryMemory(
  memory: ChapterStoryMemory,
): Promise<ChapterStoryMemory> {
  const locator = await findChapterLocation(memory.chapterId);
  if (!locator) {
    throw new Error("스토리 메모리를 저장할 화를 찾지 못했습니다.");
  }
  if (
    memory.workId !== locator.workId ||
    memory.chapterId !== locator.chapterId
  ) {
    throw new Error("스토리 메모리의 보관함 위치가 올바르지 않습니다.");
  }
  const checked = parseStoredContext(
    ChapterStoryMemorySchema,
    {
      ...memory,
      updatedAt: new Date().toISOString(),
    },
    "story-memory.json",
  );
  await writeJsonFile(
    storyMemoryPath(checked.workId, checked.chapterId),
    checked,
  );
  return checked;
}

export async function syncChapterStoryMemoryPages(
  chapterId: string,
  pages: Array<{ id: string; name: string }>,
): Promise<void> {
  const memory = await readChapterStoryMemory(chapterId);
  const reconciledPages = reconcilePageStoryMemories(memory.pages, pages);
  if (
    reconciledPages.length === memory.pages.length &&
    reconciledPages.every((page, index) => page === memory.pages[index])
  ) {
    return;
  }
  await writeChapterStoryMemory({ ...memory, pages: reconciledPages });
}

export async function resolveWorkContextForChapter(chapterId: string): Promise<{
  workId: string;
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
}> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("작품 번역 컨텍스트를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("작품 번역 컨텍스트를 찾지 못했습니다.");
  }
  const storyMemory = await readChapterStoryMemory(locator.chapterId);
  const canonicalPages = reorderRecords(chapter.pages, chapter.pageOrder);
  return {
    workId: locator.workId,
    styleGuide: await readWorkStyleGuide(locator.workId),
    storyMemory: {
      ...storyMemory,
      pages: reconcilePageStoryMemories(storyMemory.pages, canonicalPages),
    },
  };
}

function styleGuidePath(workId: string): string {
  return join(WORKS_ROOT, workId, "style-guide.json");
}

function storyMemoryPath(workId: string, chapterId: string): string {
  return join(WORKS_ROOT, workId, "chapters", chapterId, "story-memory.json");
}

async function ensureWorkExists(workId: string): Promise<void> {
  const work = await readWorkFile(workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
}

async function readOptionalContextJson(
  path: string,
  fileName: string,
): Promise<unknown | null> {
  try {
    return await readJsonFile<unknown | null>(path, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${fileName} JSON을 읽지 못했습니다. ${message}`, {
      cause: error,
    });
  }
}

function parseStoredContext<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  payload: unknown,
  fileName: string,
): z.output<TSchema> {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "payload";
  const message = issue
    ? `${path}: ${issue.message}`
    : "unknown validation error";
  throw new Error(`${fileName} 형식이 올바르지 않습니다. ${message}`);
}
