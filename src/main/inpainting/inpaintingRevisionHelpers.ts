import { resolve } from "node:path";
import type {
  ChapterSnapshot,
  MangaPage,
  TranslationCompletionReceipt,
} from "../../shared/libraryTypes";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import type { InpaintingBlockLayoutState } from "./inpaintingLayoutState";
import { openChapter as openChapterUnlocked } from "../libraryStore/libraryAccess";
import { assertChapterImagePath } from "../libraryStore/libraryFiles";
import { logInpaintingRuntimeWarn } from "./inpaintingRuntimeLogger";

export type InpaintingRevisionChange = {
  chapterId: string;
  pageId: string;
  beforeRevision?: PageRevision;
  afterRevision?: PageRevision;
  beforePath?: string;
  afterPath?: string;
  beforeMaskPath?: string;
  afterMaskPath?: string;
  beforeMaskProvenance?: MangaPage["maskProvenance"];
  afterMaskProvenance?: MangaPage["maskProvenance"];
  beforeLayout?: InpaintingBlockLayoutState[];
  afterLayout?: InpaintingBlockLayoutState[];
  beforeTranslationCompletion?: TranslationCompletionReceipt;
  afterTranslationCompletion?: TranslationCompletionReceipt;
};

export function assertRevisionLayoutPair(
  change: InpaintingRevisionChange,
): void {
  if (!optionalValuesArePaired(change.beforeRevision, change.afterRevision)) {
    throw new Error(
      "인페인팅 페이지 revision은 변경 전후 값이 모두 필요합니다.",
    );
  }
  if (!optionalValuesArePaired(change.beforeLayout, change.afterLayout)) {
    throw new Error(
      "인페인팅 텍스트 배치 기록은 변경 전후 상태가 모두 필요합니다.",
    );
  }
  if (!change.beforeLayout || !change.afterLayout) {
    return;
  }
  if (!layoutBlockIdsMatch(change.beforeLayout, change.afterLayout)) {
    throw new Error(
      "인페인팅 텍스트 배치 기록의 변경 전후 블록이 일치하지 않습니다.",
    );
  }
}

function optionalValuesArePaired(left: unknown, right: unknown): boolean {
  return Boolean(left) === Boolean(right);
}

function layoutBlockIdsMatch(
  before: InpaintingBlockLayoutState[],
  after: InpaintingBlockLayoutState[],
): boolean {
  const beforeIds = before.map((state) => state.blockId);
  const afterIds = after.map((state) => state.blockId);
  return (
    beforeIds.length === new Set(beforeIds).size &&
    afterIds.length === new Set(afterIds).size &&
    beforeIds.length === afterIds.length &&
    beforeIds.every((blockId, index) => afterIds[index] === blockId)
  );
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
  for (const imagePath of [
    change.beforePath,
    change.afterPath,
    change.beforeMaskPath,
    change.afterMaskPath,
  ]) {
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
        normalizeOptionalPath(change.beforeMaskPath),
        normalizeOptionalPath(change.afterMaskPath),
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
  return receipt
    ? {
        ...receipt,
        ...(receipt.erasedBlockIds
          ? { erasedBlockIds: [...receipt.erasedBlockIds] }
          : {}),
      }
    : undefined;
}

export function translationCompletionsEqual(
  left?: TranslationCompletionReceipt,
  right?: TranslationCompletionReceipt,
): boolean {
  if (!left || !right) {
    return !left && !right;
  }
  return (
    left.workflow === right.workflow &&
    left.status === right.status &&
    stringListsEqual(left.erasedBlockIds, right.erasedBlockIds)
  );
}

function stringListsEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right) return !left?.length && !right?.length;
  if (left.length !== right.length) return false;
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return (
    leftValues.size === left.length &&
    rightValues.size === right.length &&
    leftValues.size === rightValues.size &&
    [...leftValues].every((value) => rightValues.has(value))
  );
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
