import type {
  LibraryChapter,
  WorkShareImportEntry,
  WorkStyleGuide,
} from "../../shared/types";
import { z } from "zod";
import { tMain } from "./localization";
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
    await readZipEntries(packagePath, tMain("share.fileLabel")),
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
        tMain("share.errors.invalidChapterId"),
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
    throw new Error(tMain("share.errors.newWorkOnlyShared"));
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
    throw new Error(tMain("share.errors.requiredInfoMissing", { path }));
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
    throw new Error(tMain("share.errors.jsonRead", { path }), {
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
  throw new Error(tMain("share.errors.jsonInvalid", { path, message }));
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
    throw new Error(tMain("share.errors.invalidChapterInfo"));
  }
  const pageIds = new Set(chapter.pages.map((page) => page.id));
  for (const pageId of chapter.pageOrder) {
    if (!pageIds.has(pageId)) {
      throw new Error(tMain("share.errors.invalidPageOrder"));
    }
  }
  for (const page of chapter.pages) {
    validateSharePageImage(page, packageChapterId, entries);
    validateSharePageInpaintedImage(page, packageChapterId, entries);
  }
}

function validateSharePageImage(
  page: LibraryChapter["pages"][number],
  packageChapterId: string,
  entries: Map<string, ZipEntryLike>,
): void {
  const imagePath = normalizeShareRelativePath(
    page.imagePath,
    tMain("share.errors.invalidImagePath"),
  );
  if (!imagePath.startsWith(`chapters/${packageChapterId}/pages/`)) {
    throw new Error(tMain("share.errors.invalidImageLocation"));
  }
  assertSupportedShareImageEntry({
    entries,
    missingMessage: tMain("share.errors.packageImageMissing", {
      page: page.name,
    }),
    path: imagePath,
    unsupportedMessage: tMain("share.errors.unsupportedImage", {
      name: page.name,
    }),
  });
}

function validateSharePageInpaintedImage(
  page: LibraryChapter["pages"][number],
  packageChapterId: string,
  entries: Map<string, ZipEntryLike>,
): void {
  if (!page.inpaintedImagePath) {
    return;
  }
  const inpaintedPath = normalizeShareRelativePath(
    page.inpaintedImagePath,
    tMain("share.errors.invalidInpaintingPath"),
  );
  if (!inpaintedPath.startsWith(`chapters/${packageChapterId}/inpainted/`)) {
    throw new Error(tMain("share.errors.invalidInpaintingLocation"));
  }
  assertSupportedShareImageEntry({
    entries,
    missingMessage: tMain("share.errors.packageInpaintingMissing", {
      page: page.name,
    }),
    path: inpaintedPath,
    unsupportedMessage: tMain("share.errors.unsupportedInpaintingImage", {
      page: page.name,
    }),
  });
}

function assertSupportedShareImageEntry({
  entries,
  missingMessage,
  path,
  unsupportedMessage,
}: {
  entries: Map<string, ZipEntryLike>;
  missingMessage: string;
  path: string;
  unsupportedMessage: string;
}): void {
  if (!isSupportedImagePath(path)) {
    throw new Error(unsupportedMessage);
  }
  const entry = entries.get(path);
  if (!entry) {
    throw new Error(missingMessage);
  }
  assertZipEntrySize(entry, MAX_SHARE_IMAGE_BYTES, path);
}
