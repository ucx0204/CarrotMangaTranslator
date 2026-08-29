import { join } from "node:path";
import type { z } from "zod";
import {
  ChapterStoryMemorySchema,
  SaveWorkResearchTitleRequestSchema,
  WorkStyleGuideSchema,
  WorkResearchTitlePreferenceSchema,
} from "../../shared/ipcSchemas";
import type {
  ChapterStoryMemory,
  ResetWorkContextResult,
  SaveWorkResearchTitleRequest,
  WorkStyleGuide,
  WorkResearchTitlePreference,
} from "../../shared/workContextTypes";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { assertSafeStoreId } from "./libraryStoreIds";
import { readJsonFile, writeJsonFile } from "./storage";
import { runLibraryTransaction } from "./libraryTransaction";
import {
  stageStoryMemoryFile,
  stageStyleGuideFile,
} from "./libraryTransactionFiles";
import { reconcilePageStoryMemories } from "./storyMemoryReconcile";
import { reorderRecords } from "./chapterRecords";

const WORK_RESEARCH_PREFERENCES_FILE_NAME = "research-preferences.json";

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

export async function readWorkResearchTitlePreference(
  workId: string,
): Promise<WorkResearchTitlePreference | null> {
  await ensureWorkExists(workId);
  const raw = await readWorkResearchPreferenceJson(workId);
  if (raw === null) return null;
  const preference = parseStoredContext(
    WorkResearchTitlePreferenceSchema,
    raw,
    WORK_RESEARCH_PREFERENCES_FILE_NAME,
  );
  if (preference.workId !== workId) {
    throw new Error("작품 조사 제목의 보관함 위치가 올바르지 않습니다.");
  }
  return preference;
}

export async function writeWorkResearchTitlePreference(
  request: SaveWorkResearchTitleRequest,
): Promise<WorkResearchTitlePreference> {
  const checkedRequest = SaveWorkResearchTitleRequestSchema.parse(request);
  await ensureWorkExists(checkedRequest.workId);
  const preference = WorkResearchTitlePreferenceSchema.parse({
    schemaVersion: 1,
    workId: checkedRequest.workId,
    researchTitle: checkedRequest.researchTitle,
    updatedAt: new Date().toISOString(),
  });
  await writeJsonFile(
    workResearchPreferencesPath(preference.workId),
    preference,
  );
  return preference;
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

export async function resetWorkContextForChapter(
  chapterId: string,
): Promise<ResetWorkContextResult> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("용어/기억을 초기화할 작품을 찾지 못했습니다.");
  }
  const work = await readWorkFile(locator.workId);
  if (!work || !work.chapterOrder.includes(chapterId)) {
    throw new Error("용어/기억을 초기화할 작품을 찾지 못했습니다.");
  }

  const currentGuide = await readWorkStyleGuide(locator.workId);
  const now = new Date().toISOString();
  const styleGuide = parseStoredContext(
    WorkStyleGuideSchema,
    {
      ...currentGuide,
      glossary: [],
      characters: [],
      updatedAt: now,
    },
    "style-guide.json",
  );

  const resetMemories = work.chapterOrder.map((workChapterId) => ({
    ...createDefaultChapterStoryMemory(locator.workId, workChapterId),
    updatedAt: now,
  }));
  const requestedStoryMemory =
    resetMemories.find((memory) => memory.chapterId === chapterId) ?? null;
  await runLibraryTransaction("reset-work-context", async (transaction) => {
    await stageStyleGuideFile(transaction, styleGuide);
    for (const storyMemory of resetMemories) {
      await stageStoryMemoryFile(transaction, storyMemory);
    }
  });
  if (!requestedStoryMemory) {
    throw new Error("현재 화의 스토리 메모리를 초기화하지 못했습니다.");
  }
  return {
    styleGuide,
    storyMemory: requestedStoryMemory,
    resetChapterCount: work.chapterOrder.length,
  };
}

export function resolveReconciledStoryMemory(
  memory: ChapterStoryMemory,
  pages: Array<{ id: string; name: string }>,
  updatedAt = new Date().toISOString(),
): ChapterStoryMemory {
  const reconciledPages = reconcilePageStoryMemories(memory.pages, pages);
  if (
    reconciledPages.length === memory.pages.length &&
    reconciledPages.every((page, index) => page === memory.pages[index])
  ) {
    return memory;
  }
  return { ...memory, pages: reconciledPages, updatedAt };
}

export async function resolveWorkContextForChapter(chapterId: string): Promise<{
  workId: string;
  workTitle: string;
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
  const work = await readWorkFile(locator.workId);
  if (!work) {
    throw new Error("작품 번역 컨텍스트를 찾지 못했습니다.");
  }
  const storyMemory = await readChapterStoryMemory(locator.chapterId);
  const canonicalPages = reorderRecords(chapter.pages, chapter.pageOrder);
  return {
    workId: locator.workId,
    workTitle: work.title,
    styleGuide: await readWorkStyleGuide(locator.workId),
    storyMemory: {
      ...storyMemory,
      pages: reconcilePageStoryMemories(storyMemory.pages, canonicalPages),
    },
  };
}

function styleGuidePath(workId: string): string {
  return join(getWorksRoot(), workId, "style-guide.json");
}

function storyMemoryPath(workId: string, chapterId: string): string {
  return join(
    getWorksRoot(),
    workId,
    "chapters",
    chapterId,
    "story-memory.json",
  );
}

function workResearchPreferencesPath(workId: string): string {
  assertSafeStoreId(workId, "작품 ID가 올바르지 않습니다.");
  return join(getWorksRoot(), workId, WORK_RESEARCH_PREFERENCES_FILE_NAME);
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

async function readWorkResearchPreferenceJson(
  workId: string,
): Promise<unknown | null> {
  return readOptionalContextJson(
    workResearchPreferencesPath(workId),
    WORK_RESEARCH_PREFERENCES_FILE_NAME,
  );
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
