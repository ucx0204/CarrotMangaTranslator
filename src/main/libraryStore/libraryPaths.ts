import { join } from "node:path";
import { getAppPaths } from "../appPaths";
import { assertSafeStoreId } from "./libraryStoreIds";

export function getLibraryRoot(): string {
  return getAppPaths().libraryDir;
}

export function getWorksRoot(): string {
  return join(getLibraryRoot(), "works");
}

export function getLibraryIndexPath(): string {
  return join(getLibraryRoot(), "index.json");
}

export function getWorkFilePath(workId: string): string {
  assertSafeStoreId(workId, "작품 ID가 올바르지 않습니다.");
  return join(getWorksRoot(), workId, "work.json");
}

export function getChapterFilePath(workId: string, chapterId: string): string {
  assertSafeStoreId(workId, "작품 ID가 올바르지 않습니다.");
  assertSafeStoreId(chapterId, "화 ID가 올바르지 않습니다.");
  return join(getWorksRoot(), workId, "chapters", chapterId, "chapter.json");
}
