import { resolve } from "node:path";
import type {
  ChapterSnapshot,
  TranslationCompletionReceipt,
} from "../../shared/libraryTypes";
import type { InpaintingBlockLayoutState } from "./inpaintingLayoutState";
import { openChapter as openChapterUnlocked } from "../libraryStore/libraryAccess";
import { assertChapterImagePath } from "../libraryStore/libraryFiles";
import { logInpaintingRuntimeWarn } from "./inpaintingRuntimeLogger";

export type InpaintingRevisionChange = {
  chapterId: string;
  pageId: string;
  beforePath?: string;
  afterPath?: string;
  beforeLayout?: InpaintingBlockLayoutState[];
  afterLayout?: InpaintingBlockLayoutState[];
  beforeTranslationCompletion?: TranslationCompletionReceipt;
  afterTranslationCompletion?: TranslationCompletionReceipt;
};

export function assertRevisionLayoutPair(
  change: InpaintingRevisionChange,
): void {
  const hasBefore = change.beforeLayout !== undefined;
  const hasAfter = change.afterLayout !== undefined;
  if (hasBefore !== hasAfter) {
    throw new Error(
      "인페인팅 텍스트 배치 기록은 변경 전후 상태가 모두 필요합니다.",
    );
  }
  if (!hasBefore || !hasAfter) {
    return;
  }
  const beforeIds = change.beforeLayout?.map((state) => state.blockId) ?? [];
  const afterIds = change.afterLayout?.map((state) => state.blockId) ?? [];
  if (
    beforeIds.length !== new Set(beforeIds).size ||
    afterIds.length !== new Set(afterIds).size ||
    beforeIds.length !== afterIds.length ||
    beforeIds.some((blockId, index) => afterIds[index] !== blockId)
  ) {
    throw new Error(
      "인페인팅 텍스트 배치 기록의 변경 전후 블록이 일치하지 않습니다.",
    );
  }
}

export class InpaintingRevisionRollbackError extends Error {
  readonly currentChapters: ChapterSnapshot[];

  constructor(
    applyError: unknown,
    rollbackErrors: unknown[],
    currentChapters: ChapterSnapshot[],
  ) {
    super(
      "인페인팅 기록 적용과 롤백에 모두 실패했습니다. 최신 화 상태를 다시 불러와 주세요.",
      { cause: new AggregateError([applyError, ...rollbackErrors]) },
    );
    this.name = "InpaintingRevisionRollbackError";
    this.currentChapters = currentChapters;
  }
}

export function validateChangePaths(
  chapter: ChapterSnapshot,
  change: InpaintingRevisionChange,
): void {
  for (const imagePath of [change.beforePath, change.afterPath]) {
    if (!imagePath) continue;
    assertChapterImagePath(
      chapter.workId,
      chapter.id,
      imagePath,
      "인페인팅 기록의 이미지 경로가 올바르지 않습니다.",
    );
  }
}

export function groupChangesByChapter(
  changes: InpaintingRevisionChange[],
): Map<string, InpaintingRevisionChange[]> {
  const grouped = new Map<string, InpaintingRevisionChange[]>();
  for (const change of changes) {
    const group = grouped.get(change.chapterId) ?? [];
    group.push(change);
    grouped.set(change.chapterId, group);
  }
  return grouped;
}

export function uniqueRevisionChanges(
  changes: InpaintingRevisionChange[],
): InpaintingRevisionChange[] {
  const unique = new Map<string, InpaintingRevisionChange>();
  for (const change of changes) {
    unique.set(
      [
        change.chapterId,
        change.pageId,
        normalizeOptionalPath(change.beforePath),
        normalizeOptionalPath(change.afterPath),
      ].join("\u0000"),
      change,
    );
  }
  return [...unique.values()];
}

export function sameOptionalPath(left?: string, right?: string): boolean {
  if (!left || !right) return !left && !right;
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

export function cloneTranslationCompletion(
  receipt?: TranslationCompletionReceipt,
): TranslationCompletionReceipt | undefined {
  return receipt ? { ...receipt } : undefined;
}

export function translationCompletionsEqual(
  left?: TranslationCompletionReceipt,
  right?: TranslationCompletionReceipt,
): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return left.workflow === right.workflow && left.status === right.status;
}

export async function readCurrentChapterAfterRollbackFailure(
  chapterId: string,
): Promise<ChapterSnapshot | undefined> {
  try {
    return await openChapterUnlocked(chapterId);
  } catch (error) {
    logInpaintingRuntimeWarn(
      "Failed to reread chapter after inpainting history rollback",
      { chapterId, error },
    );
    return undefined;
  }
}

function normalizeOptionalPath(filePath?: string): string {
  if (!filePath) return "";
  const resolvedPath = resolve(filePath);
  return process.platform === "win32"
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}
