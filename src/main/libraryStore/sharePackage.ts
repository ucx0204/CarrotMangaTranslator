import type {
  LibraryChapter,
  WorkShareImportEntry,
  WorkStyleGuide,
} from "../../shared/types";
import { z } from "zod";
import {
  LibraryChapterFileSchema,
  WorkStyleGuideSchema,
} from "../../shared/ipcSchemas";
import { isSupportedImagePath } from "./storage";
import {
  MAX_SHARE_IMAGE_BYTES,
  MAX_SHARE_JSON_BYTES,
  assertZipEntrySize,
  buildSafeShareEntryMap,
  normalizeSharePathSegment,
  normalizeShareRelativePath,
  readZipEntries,
  readZipEntryDataFromFile,
  type ZipEntryLike,
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
  packagePath: string;
  entries: Map<string, ZipEntryLike>;
  manifest: ShareManifest;
  styleGuide?: WorkStyleGuide;
  chapters: Array<{
    packageChapterId: string;
    chapter: LibraryChapter;
  }>;
};

const ShareManifestSchema = z
  .object({
    format: z.literal(SHARE_FORMAT),
    version: z.literal(SHARE_VERSION),
    exportedAt: z.string().max(80),
    work: z
      .object({
        id: z.string().min(1).max(200),
        title: z.string().max(240),
      })
      .strict(),
    chapterOrder: z.array(z.string().min(1).max(200)).min(1).max(2000),
  })
  .strict();

export async function readSharePackage(
  packagePath: string,
): Promise<SharePackage> {
  const entries = buildSafeShareEntryMap(
    await readZipEntries(packagePath, "공유 파일"),
  );
  const manifest = await readRequiredShareJson(
    packagePath,
    entries,
    "manifest.json",
    ShareManifestSchema,
  );
  const styleGuide = await readOptionalShareJson(
    packagePath,
    entries,
    "style-guide.json",
    WorkStyleGuideSchema,
  );

  const chapters = await Promise.all(
    manifest.chapterOrder.map(async (packageChapterId) => {
      const safeChapterId = normalizeSharePathSegment(
        packageChapterId,
        "공유 파일의 화 ID가 올바르지 않습니다.",
      );
      const chapter = await readRequiredShareJson(
        packagePath,
        entries,
        `chapters/${safeChapterId}/chapter.json`,
        LibraryChapterFileSchema,
      );
      validateShareChapter(chapter, safeChapterId, entries);
      return {
        packageChapterId: safeChapterId,
        chapter,
      };
    }),
  );

  return {
    packagePath,
    entries,
    manifest: {
      ...manifest,
      chapterOrder: chapters.map((chapter) => chapter.packageChapterId),
    },
    styleGuide,
    chapters,
  };
}

export function assertPackageOnlyEntries(
  entries: WorkShareImportEntry[],
): asserts entries is Array<
  Extract<WorkShareImportEntry, { source: "package" }>
> {
  if (entries.some((entry) => entry.source !== "package")) {
    throw new Error(
      "새 작품으로 가져올 때는 공유 파일의 화만 선택할 수 있습니다.",
    );
  }
}

async function readRequiredShareJson<TSchema extends z.ZodTypeAny>(
  packagePath: string,
  entries: Map<string, ZipEntryLike>,
  path: string,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  const entry = entries.get(path);
  if (!entry) {
    throw new Error(`공유 파일에 필요한 정보가 없습니다: ${path}`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(
      (
        await readZipEntryDataFromFile(
          packagePath,
          entry.entryName,
          MAX_SHARE_JSON_BYTES,
          path,
        )
      ).toString("utf8"),
    );
  } catch (error) {
    throw new Error(`공유 파일의 JSON을 읽지 못했습니다: ${path}`, {
      cause: error,
    });
  }

  const result = schema.safeParse(parsedJson);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  const issuePath = issue?.path.length ? issue.path.join(".") : "payload";
  const message = issue
    ? `${issuePath}: ${issue.message}`
    : "unknown validation error";
  throw new Error(
    `공유 파일의 JSON 형식이 올바르지 않습니다: ${path} (${message})`,
  );
}

async function readOptionalShareJson<TSchema extends z.ZodTypeAny>(
  packagePath: string,
  entries: Map<string, ZipEntryLike>,
  path: string,
  schema: TSchema,
): Promise<z.output<TSchema> | undefined> {
  if (!entries.has(path)) {
    return undefined;
  }
  return readRequiredShareJson(packagePath, entries, path, schema);
}

function validateShareChapter(
  chapter: LibraryChapter,
  packageChapterId: string,
  entries: Map<string, ZipEntryLike>,
): void {
  if (
    chapter.id !== packageChapterId ||
    !Array.isArray(chapter.pages) ||
    !Array.isArray(chapter.pageOrder)
  ) {
    throw new Error("공유 파일의 화 정보가 올바르지 않습니다.");
  }
  const pageIds = new Set(chapter.pages.map((page) => page.id));
  for (const pageId of chapter.pageOrder) {
    if (!pageIds.has(pageId)) {
      throw new Error("공유 파일의 페이지 순서가 올바르지 않습니다.");
    }
  }
  for (const page of chapter.pages) {
    const imagePath = normalizeShareRelativePath(
      page.imagePath,
      "공유 파일의 이미지 경로가 올바르지 않습니다.",
    );
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

    if (page.inpaintedImagePath) {
      const inpaintedPath = normalizeShareRelativePath(
        page.inpaintedImagePath,
        "공유 파일의 인페인팅 이미지 경로가 올바르지 않습니다.",
      );
      if (
        !inpaintedPath.startsWith(`chapters/${packageChapterId}/inpainted/`)
      ) {
        throw new Error(
          "공유 파일의 인페인팅 이미지 위치가 올바르지 않습니다.",
        );
      }
      if (!isSupportedImagePath(inpaintedPath)) {
        throw new Error(
          `지원하지 않는 인페인팅 이미지 형식입니다: ${page.name}`,
        );
      }
      const inpaintedEntry = entries.get(inpaintedPath);
      if (!inpaintedEntry) {
        throw new Error(`공유 파일에 인페인팅 이미지가 없습니다: ${page.name}`);
      }
      assertZipEntrySize(inpaintedEntry, MAX_SHARE_IMAGE_BYTES, inpaintedPath);
    }
  }
}
