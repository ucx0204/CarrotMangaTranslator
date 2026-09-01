import type { LibraryChapter } from "../../shared/libraryTypes";
import { MAX_ID_LIST_LENGTH } from "../../shared/ipcSchemaPrimitives";
import type { WorkShareImportEntry } from "../../shared/shareTypes";
import type { WorkStyleGuide } from "../../shared/workContextTypes";
import { z } from "zod";
import { throwIfAborted } from "../abortSignal";
import { assertUniqueTranslationBlockIds } from "../translationCompletionReferences";
import { tMain } from "./localization";
import {
  LibraryChapterFileSchema,
  WorkStyleGuideSchema,
} from "../../shared/ipcSchemas";
import { isSupportedImagePath } from "./storage";
import {
  MAX_SHARE_CHAPTER_JSON_BYTES,
  MAX_SHARE_IMAGE_BYTES,
  MAX_SHARE_JSON_BYTES,
  assertZipEntrySize,
  buildSafeShareEntryMap,
  normalizeSharePathSegment,
  normalizeShareRelativePath,
  openZipArchiveReader,
  type ZipArchiveReader,
  type ZipEntryLike,
} from "./zipSafety";

export const SHARE_FORMAT = "manga-gemma-translator-share";
export const SHARE_VERSION = 1;
export const MAX_SHARE_CHAPTERS = MAX_ID_LIST_LENGTH;

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

export type SharePackageSession = {
  readonly packagePath: string;
  readonly entries: ReadonlyMap<string, ZipEntryLike>;
  readonly manifest: ShareManifest;
  readonly styleGuide?: WorkStyleGuide;
  readonly archiveReader: Pick<ZipArchiveReader, "readEntry">;
  readChapter: (
    packageChapterId: string,
    signal?: AbortSignal,
  ) => Promise<LibraryChapter>;
  close: () => void;
};

export type SharePackageReaderRuntime = {
  openArchive: typeof openZipArchiveReader;
};

const productionSharePackageReaderRuntime: SharePackageReaderRuntime = {
  openArchive: openZipArchiveReader,
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
    chapterOrder: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(MAX_SHARE_CHAPTERS)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "duplicate chapter id",
      }),
  })
  .strict();

export async function openSharePackageSession(
  packagePath: string,
  {
    signal,
    runtime = productionSharePackageReaderRuntime,
  }: {
    signal?: AbortSignal;
    runtime?: SharePackageReaderRuntime;
  } = {},
): Promise<SharePackageSession> {
  throwIfAborted(signal);
  const archiveReader = await runtime.openArchive(
    packagePath,
    tMain("share.fileLabel"),
  );
  let sessionReturned = false;

  try {
    throwIfAborted(signal);
    const entries = buildSafeShareEntryMap(archiveReader.entries);
    const manifest = await readRequiredShareJson(
      archiveReader,
      entries,
      "manifest.json",
      ShareManifestSchema,
      signal,
    );
    const { normalizedManifest, chapterEntryById } = validateManifestChapters(
      manifest,
      entries,
    );
    const styleGuide = await readOptionalShareJson(
      archiveReader,
      entries,
      "style-guide.json",
      WorkStyleGuideSchema,
      signal,
    );
    const session = createSharePackageSession({
      packagePath,
      archiveReader,
      entries,
      manifest: normalizedManifest,
      styleGuide,
      chapterEntryById,
    });
    sessionReturned = true;
    return session;
  } finally {
    if (!sessionReturned) {
      archiveReader.close();
    }
  }
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
  reader: Pick<ZipArchiveReader, "readEntry">,
  entries: ReadonlyMap<string, ZipEntryLike>,
  path: string,
  schema: TSchema,
  signal?: AbortSignal,
  maxBytes = MAX_SHARE_JSON_BYTES,
): Promise<z.output<TSchema>> {
  throwIfAborted(signal);
  const entry = entries.get(path);
  if (!entry) {
    throw new Error(tMain("share.errors.requiredInfoMissing", { path }));
  }
  assertZipEntrySize(entry, maxBytes, path);
  const data = await reader.readEntry(entry.entryName, maxBytes, path);
  throwIfAborted(signal);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(data.toString("utf8"));
  } catch (error) {
    throw new Error(tMain("share.errors.jsonRead", { path }), {
      cause: error,
    });
  }

  throwIfAborted(signal);
  const result = schema.safeParse(parsedJson);
  throwIfAborted(signal);
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
  reader: Pick<ZipArchiveReader, "readEntry">,
  entries: ReadonlyMap<string, ZipEntryLike>,
  path: string,
  schema: TSchema,
  signal?: AbortSignal,
): Promise<z.output<TSchema> | undefined> {
  if (!entries.has(path)) {
    return undefined;
  }
  return readRequiredShareJson(reader, entries, path, schema, signal);
}

function validateManifestChapters(
  manifest: ShareManifest,
  entries: ReadonlyMap<string, ZipEntryLike>,
): {
  normalizedManifest: ShareManifest;
  chapterEntryById: ReadonlyMap<string, ZipEntryLike>;
} {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  const chapterEntryById = new Map<string, ZipEntryLike>();

  for (const rawId of manifest.chapterOrder) {
    const id = normalizeSharePathSegment(
      rawId,
      tMain("share.errors.invalidChapterId"),
    );
    if (seen.has(id)) {
      throw new Error(tMain("share.errors.duplicateSharedChapter"));
    }
    seen.add(id);

    const path = `chapters/${id}/chapter.json`;
    const entry = entries.get(path);
    if (!entry) {
      throw new Error(tMain("share.errors.requiredInfoMissing", { path }));
    }
    assertZipEntrySize(entry, MAX_SHARE_CHAPTER_JSON_BYTES, path);
    normalizedIds.push(id);
    chapterEntryById.set(id, entry);
  }

  return {
    normalizedManifest: {
      ...manifest,
      chapterOrder: normalizedIds,
    },
    chapterEntryById,
  };
}

function createSharePackageSession({
  packagePath,
  archiveReader,
  entries,
  manifest,
  styleGuide,
  chapterEntryById,
}: {
  packagePath: string;
  archiveReader: ZipArchiveReader;
  entries: ReadonlyMap<string, ZipEntryLike>;
  manifest: ShareManifest;
  styleGuide?: WorkStyleGuide;
  chapterEntryById: ReadonlyMap<string, ZipEntryLike>;
}): SharePackageSession {
  let closed = false;
  let chapterReadTail: Promise<void> = Promise.resolve();

  const readChapterNow = async (
    packageChapterId: string,
    signal?: AbortSignal,
  ): Promise<LibraryChapter> => {
    if (closed) {
      throw new Error("Share package reader is closed.");
    }
    throwIfAborted(signal);
    const safeId = normalizeSharePathSegment(
      packageChapterId,
      tMain("share.errors.invalidChapterId"),
    );
    if (!chapterEntryById.has(safeId)) {
      throw new Error(tMain("share.errors.chapterNotFound"));
    }
    const chapter = await readRequiredShareJson(
      archiveReader,
      entries,
      `chapters/${safeId}/chapter.json`,
      LibraryChapterFileSchema,
      signal,
      MAX_SHARE_CHAPTER_JSON_BYTES,
    );
    throwIfAborted(signal);
    validateShareChapter(chapter, safeId, entries);
    return chapter;
  };

  const readChapter = (
    packageChapterId: string,
    signal?: AbortSignal,
  ): Promise<LibraryChapter> => {
    const task = chapterReadTail.then(() =>
      readChapterNow(packageChapterId, signal),
    );
    chapterReadTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  return {
    packagePath,
    entries,
    manifest,
    styleGuide,
    archiveReader,
    readChapter,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      archiveReader.close();
    },
  };
}

function validateShareChapter(
  chapter: LibraryChapter,
  packageChapterId: string,
  entries: ReadonlyMap<string, ZipEntryLike>,
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
    assertUniqueTranslationBlockIds(
      page.blocks,
      tMain("share.errors.duplicateBlockId", { page: page.name }),
    );
    validateSharePageImage(page, packageChapterId, entries);
    validateSharePageInpaintedImage(page, packageChapterId, entries);
  }
}

function validateSharePageImage(
  page: LibraryChapter["pages"][number],
  packageChapterId: string,
  entries: ReadonlyMap<string, ZipEntryLike>,
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
  entries: ReadonlyMap<string, ZipEntryLike>,
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
  entries: ReadonlyMap<string, ZipEntryLike>;
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
