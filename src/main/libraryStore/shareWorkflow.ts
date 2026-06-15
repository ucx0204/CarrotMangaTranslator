import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type {
  LibraryPageRecord,
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportFromPackageRequest,
  WorkShareImportPreviewView,
  WorkShareImportResult,
} from "../../shared/types";
import { reorderRecords, resolveChapterStatus } from "./chapterRecords";
import { hydrateChapter } from "./chapterSnapshots";
import {
  readDecodedImportImageSize,
  shouldNormalizeImportImageToPng,
  writeNormalizedWebpImportImage,
} from "./importImages";
import {
  WORKS_ROOT,
  createWork,
  ensureExistingWork,
  readChapterFile,
  removeChapterDirectory,
  removeWorkFromIndexAndDisk,
  writeChapterFile,
  writeWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import {
  SHARE_FORMAT,
  SHARE_VERSION,
  assertPackageOnlyEntries,
  readSharePackage,
  type ShareManifest,
  type SharePackage,
} from "./sharePackage";
import { isPathInside, isSupportedImagePath, safeUnlink } from "./storage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";
import {
  AdmZip,
  MAX_SHARE_IMAGE_BYTES,
  normalizeShareRelativePath,
  openZipArchiveReader,
  type ZipArchiveReader,
  type ZipEntryLike,
} from "./zipSafety";

export async function exportWorkShareToFile(
  request: WorkShareExportRequest & { outputPath: string },
): Promise<WorkShareExportResult> {
  const work = await ensureExistingWork(request.workId);
  const requestedIds = new Set(request.chapterIds);
  const chapterIds = work.chapterOrder.filter((chapterId) =>
    requestedIds.has(chapterId),
  );
  if (chapterIds.length === 0) {
    throw new Error("공유할 화를 선택해 주세요.");
  }

  const zip = new AdmZip();
  const manifest: ShareManifest = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt: new Date().toISOString(),
    work: {
      id: work.id,
      title: work.title,
    },
    chapterOrder: chapterIds,
  };

  zip.addFile(
    "manifest.json",
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );

  let pageCount = 0;
  for (const chapterId of chapterIds) {
    const chapter = await readChapterFile(work.id, chapterId);
    if (!chapter) {
      throw new Error("공유할 화를 찾지 못했습니다.");
    }

    const packagePages: LibraryPageRecord[] = [];
    const orderedPages = reorderRecords(chapter.pages, chapter.pageOrder);
    for (const [pageIndex, page] of orderedPages.entries()) {
      const imageExt = extname(page.imagePath).toLowerCase() || ".png";
      const packageImagePath = `chapters/${chapter.id}/pages/${String(pageIndex + 1).padStart(3, "0")}-${page.id}${imageExt}`;
      await addImageFileToShare({
        zip,
        sourcePath: page.imagePath,
        packagePath: packageImagePath,
        displayName: page.name,
        missingMessage: `원본 이미지를 찾지 못했습니다: ${page.name}`,
      });

      let packageInpaintedImagePath: string | undefined;
      if (page.inpaintedImagePath) {
        const inpaintedExt =
          extname(page.inpaintedImagePath).toLowerCase() || ".png";
        packageInpaintedImagePath = `chapters/${chapter.id}/inpainted/${String(pageIndex + 1).padStart(3, "0")}-${page.id}-inpainted${inpaintedExt}`;
        await addImageFileToShare({
          zip,
          sourcePath: page.inpaintedImagePath,
          packagePath: packageInpaintedImagePath,
          displayName: `${page.name} 인페인팅 결과`,
          missingMessage: `인페인팅 결과 이미지를 찾지 못했습니다: ${page.name}`,
        });
      }

      packagePages.push({
        ...page,
        imagePath: packageImagePath,
        inpaintedImagePath: packageInpaintedImagePath,
      });
      pageCount += 1;
    }

    const packageChapter: ChapterFile = {
      ...chapter,
      pageOrder: orderedPages.map((page) => page.id),
      pages: packagePages,
    };
    zip.addFile(
      `chapters/${chapter.id}/chapter.json`,
      Buffer.from(`${JSON.stringify(packageChapter, null, 2)}\n`, "utf8"),
    );
  }

  await mkdir(dirname(request.outputPath), { recursive: true });
  zip.writeZip(request.outputPath);

  return {
    filePath: request.outputPath,
    workTitle: work.title,
    chapterCount: chapterIds.length,
    pageCount,
  };
}

async function addImageFileToShare({
  zip,
  sourcePath,
  packagePath,
  displayName,
  missingMessage,
}: {
  zip: { addFile: (entryName: string, content: Buffer | string) => void };
  sourcePath: string;
  packagePath: string;
  displayName: string;
  missingMessage: string;
}): Promise<void> {
  if (!existsSync(sourcePath)) {
    throw new Error(missingMessage);
  }
  if (!isSupportedImagePath(sourcePath) || !isSupportedImagePath(packagePath)) {
    throw new Error(`지원하지 않는 이미지 형식입니다: ${displayName}`);
  }
  const sourceStat = await stat(sourcePath);
  if (sourceStat.size > MAX_SHARE_IMAGE_BYTES) {
    throw new Error(`${displayName} 파일이 너무 큽니다.`);
  }
  zip.addFile(packagePath, await readFile(sourcePath));
}

export async function previewWorkShareImport(
  packagePath: string,
): Promise<WorkShareImportPreviewView> {
  const sharePackage = await readSharePackage(packagePath);
  return {
    workTitle: sharePackage.manifest.work.title,
    chapters: sharePackage.chapters.map(({ packageChapterId, chapter }) => ({
      packageChapterId,
      title: chapter.title,
      pageCount: chapter.pages.length,
    })),
  };
}

export async function importWorkShareUnlocked(
  request: WorkShareImportFromPackageRequest,
): Promise<WorkShareImportResult> {
  const sharePackage = await readSharePackage(request.packagePath);
  const archiveReader = await openZipArchiveReader(request.packagePath, "공유 파일");
  if (request.entries.length === 0) {
    archiveReader.close();
    throw new Error("가져올 화가 없습니다.");
  }

  try {
    if (request.target.mode === "new") {
      return await importWorkShareAsNewWork(sharePackage, archiveReader, request);
    }

    return await importWorkShareIntoExistingWork(sharePackage, archiveReader, request);
  } finally {
    archiveReader.close();
  }
}

async function importWorkShareAsNewWork(
  sharePackage: SharePackage,
  archiveReader: ZipArchiveReader,
  request: WorkShareImportFromPackageRequest,
): Promise<WorkShareImportResult> {
  if (request.target.mode !== "new") {
    throw new Error("새 작품 가져오기 요청이 아닙니다.");
  }
  assertPackageOnlyEntries(request.entries);

  const work = await createWork(
    request.target.title || sharePackage.manifest.work.title,
  );
  const chapterByPackageId = new Map(
    sharePackage.chapters.map((item) => [item.packageChapterId, item.chapter]),
  );
  const usedTitles = new Set<string>();
  const createdChapters: ChapterFile[] = [];

  try {
    for (const entry of request.entries) {
      const packageChapter = chapterByPackageId.get(entry.packageChapterId);
      if (!packageChapter) {
        throw new Error("공유 파일에서 가져올 화를 찾지 못했습니다.");
      }
      const title = makeUniqueTitleInList(
        sanitizeTitle(entry.title || packageChapter.title, "제목없음"),
        usedTitles,
      );
      const chapter = await materializeSharedChapter({
        workId: work.id,
        packageChapter,
        entries: sharePackage.entries,
        archiveReader,
        requestedTitle: title,
      });
      createdChapters.push(chapter);
    }

    if (createdChapters.length === 0) {
      throw new Error("가져올 화가 없습니다.");
    }

    const chapterIds = createdChapters.map((chapter) => chapter.id);
    work.chapterOrder = chapterIds;
    work.updatedAt = new Date().toISOString();
    await writeWorkFile(work);

    const openedChapter = createdChapters[0];
    if (!openedChapter) {
      throw new Error("가져온 화를 열지 못했습니다.");
    }

    return {
      workId: work.id,
      chapterIds,
      openedChapter: hydrateChapter(openedChapter),
    };
  } catch (error) {
    for (const chapter of createdChapters) {
      await removeChapterDirectory(chapter.workId, chapter.id);
    }
    await removeWorkFromIndexAndDisk(work.id);
    throw error;
  }
}

async function importWorkShareIntoExistingWork(
  sharePackage: SharePackage,
  archiveReader: ZipArchiveReader,
  request: WorkShareImportFromPackageRequest,
): Promise<WorkShareImportResult> {
  if (request.target.mode !== "existing") {
    throw new Error("기존 작품 가져오기 요청이 아닙니다.");
  }

  const work = await ensureExistingWork(request.target.workId);
  const originalWork: WorkFile = {
    ...work,
    chapterOrder: [...work.chapterOrder],
  };
  const currentChapters = new Map<string, ChapterFile>();
  for (const chapterId of work.chapterOrder) {
    const chapter = await readChapterFile(work.id, chapterId);
    if (chapter) {
      currentChapters.set(chapterId, chapter);
    }
  }

  const chapterByPackageId = new Map(
    sharePackage.chapters.map((item) => [item.packageChapterId, item.chapter]),
  );
  const usedTitles = new Set<string>();
  const usedExistingIds = new Set<string>();
  const usedPackageIds = new Set<string>();
  const finalChapterIds: string[] = [];
  const updatedExistingChapters: ChapterFile[] = [];
  const createdPackageChapters: ChapterFile[] = [];
  const trashedExistingChapters: TrashedChapterDirectory[] = [];
  const now = new Date().toISOString();

  try {
    for (const entry of request.entries) {
      if (entry.source === "existing") {
        if (usedExistingIds.has(entry.chapterId)) {
          throw new Error("같은 기존 화가 두 번 포함되어 있습니다.");
        }
        const currentChapter = currentChapters.get(entry.chapterId);
        if (!currentChapter) {
          throw new Error("기존 작품에서 적용할 화를 찾지 못했습니다.");
        }
        const chapter = {
          ...currentChapter,
          title: makeUniqueTitleInList(
            sanitizeTitle(entry.title || currentChapter.title, "제목없음"),
            usedTitles,
          ),
          updatedAt: now,
        };
        updatedExistingChapters.push(chapter);
        usedExistingIds.add(chapter.id);
        finalChapterIds.push(chapter.id);
        continue;
      }

      if (usedPackageIds.has(entry.packageChapterId)) {
        throw new Error("같은 공유 화가 두 번 포함되어 있습니다.");
      }
      const packageChapter = chapterByPackageId.get(entry.packageChapterId);
      if (!packageChapter) {
        throw new Error("공유 파일에서 가져올 화를 찾지 못했습니다.");
      }
      const title = makeUniqueTitleInList(
        sanitizeTitle(entry.title || packageChapter.title, "제목없음"),
        usedTitles,
      );
      const chapter = await materializeSharedChapter({
        workId: work.id,
        packageChapter,
        entries: sharePackage.entries,
        archiveReader,
        requestedTitle: title,
      });
      createdPackageChapters.push(chapter);
      usedPackageIds.add(entry.packageChapterId);
      finalChapterIds.push(chapter.id);
    }

    if (finalChapterIds.length === 0) {
      throw new Error("적용할 화가 없습니다.");
    }

    const previousChapterIds = [...work.chapterOrder];
    const nextWork: WorkFile = {
      ...work,
      chapterOrder: finalChapterIds,
      updatedAt: now,
    };

    for (const chapter of updatedExistingChapters) {
      await writeChapterFile(chapter);
    }

    await writeWorkFile(nextWork);

    trashedExistingChapters.push(
      ...(await moveOmittedExistingChaptersToTrash(
        work.id,
        previousChapterIds,
        finalChapterIds,
      )),
    );

    const firstChapterId = finalChapterIds[0];
    if (!firstChapterId) {
      throw new Error("가져온 화를 열지 못했습니다.");
    }
    const openedChapter = await readChapterFile(work.id, firstChapterId);
    if (!openedChapter) {
      throw new Error("가져온 화를 열지 못했습니다.");
    }

    await discardTrashedChapterDirectories(work.id, trashedExistingChapters);

    return {
      workId: work.id,
      chapterIds: finalChapterIds,
      openedChapter: hydrateChapter(openedChapter),
    };
  } catch (error) {
    await restoreTrashedChapterDirectories(
      work.id,
      trashedExistingChapters,
    ).catch(() => {});
    for (const chapter of createdPackageChapters) {
      await removeChapterDirectory(chapter.workId, chapter.id);
    }
    for (const chapter of updatedExistingChapters) {
      const originalChapter = currentChapters.get(chapter.id);
      if (originalChapter) {
        await writeChapterFile(originalChapter).catch(() => {});
      }
    }
    await writeWorkFile(originalWork).catch(() => {});
    throw error;
  }
}

type TrashedChapterDirectory = {
  chapterId: string;
  sourceDir: string;
  trashDir: string;
  operationTrashRoot: string;
};

async function moveOmittedExistingChaptersToTrash(
  workId: string,
  previousChapterIds: string[],
  finalChapterIds: string[],
): Promise<TrashedChapterDirectory[]> {
  const finalChapterIdSet = new Set(finalChapterIds);
  const operationId = randomUUID();
  const trashedChapters: TrashedChapterDirectory[] = [];

  for (const chapterId of previousChapterIds) {
    if (finalChapterIdSet.has(chapterId)) {
      continue;
    }

    const sourceDir = resolveChapterDirectory(workId, chapterId);
    if (!existsSync(sourceDir)) {
      continue;
    }

    const operationTrashRoot = resolveOperationTrashRoot(workId, operationId);
    const trashDir = resolve(join(operationTrashRoot, chapterId));
    if (
      !isPathInside(operationTrashRoot, trashDir) ||
      trashDir === operationTrashRoot
    ) {
      throw new Error("공유 가져오기 임시 보관 위치가 올바르지 않습니다.");
    }

    await mkdir(operationTrashRoot, { recursive: true });
    await rename(sourceDir, trashDir);
    trashedChapters.push({
      chapterId,
      sourceDir,
      trashDir,
      operationTrashRoot,
    });
  }

  return trashedChapters;
}

async function restoreTrashedChapterDirectories(
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  for (const trashedChapter of [...trashedChapters].reverse()) {
    if (!existsSync(trashedChapter.trashDir)) {
      continue;
    }
    await mkdir(dirname(trashedChapter.sourceDir), { recursive: true });
    if (existsSync(trashedChapter.sourceDir)) {
      continue;
    }
    await rename(trashedChapter.trashDir, trashedChapter.sourceDir);
  }

  await pruneTrashRoots(workId, trashedChapters);
}

async function discardTrashedChapterDirectories(
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  const operationTrashRoots = new Set(
    trashedChapters.map((trashedChapter) => trashedChapter.operationTrashRoot),
  );
  for (const operationTrashRoot of operationTrashRoots) {
    await rm(operationTrashRoot, { recursive: true, force: true });
  }
  await pruneTrashRoots(workId, trashedChapters);
}

async function pruneTrashRoots(
  workId: string,
  trashedChapters: TrashedChapterDirectory[],
): Promise<void> {
  const operationTrashRoots = new Set(
    trashedChapters.map((trashedChapter) => trashedChapter.operationTrashRoot),
  );
  for (const operationTrashRoot of operationTrashRoots) {
    await rmdir(operationTrashRoot).catch(() => {});
  }
  await rmdir(resolveTrashRoot(workId)).catch(() => {});
}

function resolveChapterDirectory(workId: string, chapterId: string): string {
  const chaptersRoot = resolve(join(WORKS_ROOT, workId, "chapters"));
  const chapterDir = resolve(join(chaptersRoot, chapterId));
  if (!isPathInside(chaptersRoot, chapterDir) || chapterDir === chaptersRoot) {
    throw new Error("화 정보의 보관함 위치가 올바르지 않습니다.");
  }
  return chapterDir;
}

function resolveOperationTrashRoot(
  workId: string,
  operationId: string,
): string {
  const trashRoot = resolveTrashRoot(workId);
  const operationTrashRoot = resolve(join(trashRoot, operationId));
  if (
    !isPathInside(trashRoot, operationTrashRoot) ||
    operationTrashRoot === trashRoot
  ) {
    throw new Error("공유 가져오기 임시 보관 위치가 올바르지 않습니다.");
  }
  return operationTrashRoot;
}

function resolveTrashRoot(workId: string): string {
  const chaptersRoot = resolve(join(WORKS_ROOT, workId, "chapters"));
  const trashRoot = resolve(join(chaptersRoot, ".trash"));
  if (!isPathInside(chaptersRoot, trashRoot) || trashRoot === chaptersRoot) {
    throw new Error("공유 가져오기 임시 보관 위치가 올바르지 않습니다.");
  }
  return trashRoot;
}

async function materializeSharedChapter({
  workId,
  packageChapter,
  entries,
  archiveReader,
  requestedTitle,
}: {
  workId: string;
  packageChapter: ChapterFile;
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  requestedTitle: string;
}): Promise<ChapterFile> {
  const now = new Date().toISOString();
  const chapterId = randomUUID();
  const chapterDir = join(WORKS_ROOT, workId, "chapters", chapterId);
  const pagesDir = join(chapterDir, "pages");
  const inpaintedDir = join(chapterDir, "inpainted");
  try {
    await mkdir(pagesDir, { recursive: true });

    const pages: LibraryPageRecord[] = [];
    for (const [index, packagePage] of reorderRecords(
      packageChapter.pages,
      packageChapter.pageOrder,
    ).entries()) {
      const packageImagePath = normalizeShareRelativePath(
        packagePage.imagePath,
        "페이지 이미지 경로가 올바르지 않습니다.",
      );

      const pageId = randomUUID();
      const sourceExt = extname(packageImagePath).toLowerCase() || ".png";
      const targetExt = shouldNormalizeImportImageToPng(sourceExt)
        ? ".png"
        : sourceExt;
      const outputPath = join(
        pagesDir,
        `${String(index + 1).padStart(3, "0")}-${pageId}${targetExt}`,
      );
      await writePackageImageEntry({
        entries,
        archiveReader,
        packageImagePath,
        outputPath,
        displayName: packagePage.name,
        missingMessage: `공유 파일에 이미지가 없습니다: ${packagePage.name}`,
      });

      const inpaintedImagePath = await materializeSharedInpaintedImage({
        entries,
        archiveReader,
        packagePage,
        pageId,
        index,
        inpaintedDir,
      });

      const size = await readDecodedImportImageSize(
        outputPath,
        packagePage.name,
      );
      pages.push({
        ...packagePage,
        id: pageId,
        imagePath: outputPath,
        inpaintedImagePath,
        width: size.width || packagePage.width || 1000,
        height: size.height || packagePage.height || 1400,
        blocks: packagePage.blocks.map((block, blockIndex) => ({
          ...block,
          id: `${pageId}-block-${blockIndex + 1}`,
        })),
        createdAt: now,
        updatedAt: now,
      });
    }

    const chapter: ChapterFile = {
      ...packageChapter,
      id: chapterId,
      workId,
      title: requestedTitle,
      status: resolveChapterStatus(pages),
      pageOrder: pages.map((page) => page.id),
      pages,
      createdAt: now,
      updatedAt: now,
    };
    await writeChapterFile(chapter);
    return chapter;
  } catch (error) {
    await removeChapterDirectory(workId, chapterId);
    throw error;
  }
}

async function materializeSharedInpaintedImage({
  entries,
  archiveReader,
  packagePage,
  pageId,
  index,
  inpaintedDir,
}: {
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  packagePage: LibraryPageRecord;
  pageId: string;
  index: number;
  inpaintedDir: string;
}): Promise<string | undefined> {
  if (!packagePage.inpaintedImagePath) {
    return undefined;
  }

  const packageInpaintedPath = normalizeShareRelativePath(
    packagePage.inpaintedImagePath,
    "인페인팅 결과 이미지 경로가 올바르지 않습니다.",
  );
  const sourceExt = extname(packageInpaintedPath).toLowerCase() || ".png";
  const targetExt = shouldNormalizeImportImageToPng(sourceExt)
    ? ".png"
    : sourceExt;
  const outputPath = join(
    inpaintedDir,
    `${String(index + 1).padStart(3, "0")}-${pageId}-inpainted${targetExt}`,
  );

  await mkdir(inpaintedDir, { recursive: true });
  await writePackageImageEntry({
    entries,
    archiveReader,
    packageImagePath: packageInpaintedPath,
    outputPath,
    displayName: `${packagePage.name} 인페인팅 결과`,
    missingMessage: `공유 파일에 인페인팅 결과 이미지가 없습니다: ${packagePage.name}`,
  });
  return outputPath;
}

async function writePackageImageEntry({
  entries,
  archiveReader,
  packageImagePath,
  outputPath,
  displayName,
  missingMessage,
}: {
  entries: Map<string, ZipEntryLike>;
  archiveReader: ZipArchiveReader;
  packageImagePath: string;
  outputPath: string;
  displayName: string;
  missingMessage: string;
}): Promise<void> {
  if (!isSupportedImagePath(packageImagePath)) {
    throw new Error(`지원하지 않는 이미지 형식입니다: ${displayName}`);
  }

  const entry = entries.get(packageImagePath);
  if (!entry) {
    throw new Error(missingMessage);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const sourceExt = extname(packageImagePath).toLowerCase() || ".png";
  const sourceBytes = await archiveReader.readEntry(
    entry.entryName,
    MAX_SHARE_IMAGE_BYTES,
    packageImagePath,
  );
  if (shouldNormalizeImportImageToPng(sourceExt)) {
    const tempSourcePath = join(
      dirname(outputPath),
      `.${randomUUID()}.share-source${sourceExt}`,
    );
    try {
      await writeFile(tempSourcePath, sourceBytes);
      await writeNormalizedWebpImportImage(
        tempSourcePath,
        outputPath,
        displayName,
      );
    } finally {
      await safeUnlink(tempSourcePath);
    }
    return;
  }

  await writeFile(outputPath, sourceBytes);
}
