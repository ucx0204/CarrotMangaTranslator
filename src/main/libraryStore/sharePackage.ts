import type { LibraryChapter, WorkShareImportEntry } from "../../shared/types";
import { isSupportedImagePath } from "./storage";
import {
  AdmZip,
  MAX_SHARE_IMAGE_BYTES,
  MAX_SHARE_JSON_BYTES,
  assertZipEntrySize,
  buildSafeShareEntryMap,
  normalizeSharePathSegment,
  normalizeShareRelativePath,
  readZipEntryData,
  type ZipEntryLike
} from "./zipSafety";

export const SHARE_FORMAT = "manga-gemma-translator-share";
export const SHARE_VERSION = 1;

export type ShareManifest = {
  format: string;
  version: number;
  exportedAt: string;
  work: {
    id: string;
    title: string;
  };
  chapterOrder: string[];
};

export type SharePackage = {
  entries: Map<string, ZipEntryLike>;
  manifest: ShareManifest;
  chapters: Array<{
    packageChapterId: string;
    chapter: LibraryChapter;
  }>;
};

export function readSharePackage(packagePath: string): SharePackage {
  const zip = new AdmZip(packagePath);
  const entries = buildSafeShareEntryMap(zip.getEntries());
  const manifest = readRequiredShareJson<ShareManifest>(entries, "manifest.json");
  validateShareManifest(manifest);

  const chapters = manifest.chapterOrder.map((packageChapterId) => {
    const safeChapterId = normalizeSharePathSegment(packageChapterId, "공유 파일의 화 ID가 올바르지 않습니다.");
    const chapter = readRequiredShareJson<LibraryChapter>(entries, `chapters/${safeChapterId}/chapter.json`);
    validateShareChapter(chapter, safeChapterId, entries);
    return {
      packageChapterId: safeChapterId,
      chapter
    };
  });

  return {
    entries,
    manifest: {
      ...manifest,
      chapterOrder: chapters.map((chapter) => chapter.packageChapterId)
    },
    chapters
  };
}

export function assertPackageOnlyEntries(
  entries: WorkShareImportEntry[]
): asserts entries is Array<Extract<WorkShareImportEntry, { source: "package" }>> {
  if (entries.some((entry) => entry.source !== "package")) {
    throw new Error("새 작품으로 가져올 때는 공유 파일의 화만 선택할 수 있습니다.");
  }
}

function readRequiredShareJson<T>(entries: Map<string, ZipEntryLike>, path: string): T {
  const entry = entries.get(path);
  if (!entry) {
    throw new Error(`공유 파일에 필요한 정보가 없습니다: ${path}`);
  }
  try {
    return JSON.parse(readZipEntryData(entry, MAX_SHARE_JSON_BYTES, path).toString("utf8")) as T;
  } catch {
    throw new Error(`공유 파일의 JSON을 읽지 못했습니다: ${path}`);
  }
}

function validateShareManifest(manifest: ShareManifest): void {
  if (manifest.format !== SHARE_FORMAT || manifest.version !== SHARE_VERSION) {
    throw new Error("지원하지 않는 공유 파일 버전입니다.");
  }
  if (!manifest.work || typeof manifest.work.title !== "string") {
    throw new Error("공유 파일의 작품 정보가 올바르지 않습니다.");
  }
  if (!Array.isArray(manifest.chapterOrder) || manifest.chapterOrder.length === 0) {
    throw new Error("공유 파일에 화 정보가 없습니다.");
  }
}

function validateShareChapter(chapter: LibraryChapter, packageChapterId: string, entries: Map<string, ZipEntryLike>): void {
  if (chapter.id !== packageChapterId || !Array.isArray(chapter.pages) || !Array.isArray(chapter.pageOrder)) {
    throw new Error("공유 파일의 화 정보가 올바르지 않습니다.");
  }
  const pageIds = new Set(chapter.pages.map((page) => page.id));
  for (const pageId of chapter.pageOrder) {
    if (!pageIds.has(pageId)) {
      throw new Error("공유 파일의 페이지 순서가 올바르지 않습니다.");
    }
  }
  for (const page of chapter.pages) {
    const imagePath = normalizeShareRelativePath(page.imagePath, "공유 파일의 이미지 경로가 올바르지 않습니다.");
    if (!imagePath.startsWith(`chapters/${packageChapterId}/pages/`)) {
      throw new Error("공유 파일의 이미지 위치가 올바르지 않습니다.");
    }
    if (!isSupportedImagePath(imagePath)) {
      throw new Error(`지원하지 않는 이미지 형식입니다: ${page.name}`);
    }
    const imageEntry = entries.get(imagePath);
    if (!imageEntry) {
      throw new Error(`공유 파일에 이미지가 없습니다: ${page.name}`);
    }
    assertZipEntrySize(imageEntry, MAX_SHARE_IMAGE_BYTES, imagePath);
  }
}
