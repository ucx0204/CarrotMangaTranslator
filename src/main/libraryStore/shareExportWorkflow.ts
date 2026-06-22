import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type {
  LibraryPageRecord,
  WorkShareExportRequest,
  WorkShareExportResult,
} from "../../shared/types";
import { reorderRecords } from "./chapterRecords";
import {
  ensureExistingWork,
  readChapterFile,
  type ChapterFile,
} from "./libraryFiles";
import { readWorkStyleGuide } from "./workContextFiles";
import {
  SHARE_FORMAT,
  SHARE_VERSION,
  type ShareManifest,
} from "./sharePackage";
import { isSupportedImagePath } from "./storage";
import { AdmZip, MAX_SHARE_IMAGE_BYTES } from "./zipSafety";

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
  zip.addFile(
    "style-guide.json",
    Buffer.from(
      `${JSON.stringify(await readWorkStyleGuide(work.id), null, 2)}\n`,
      "utf8",
    ),
  );

  let pageCount = 0;
  for (const chapterId of chapterIds) {
    pageCount += await addChapterToShare(zip, work.id, chapterId);
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

async function addChapterToShare(
  zip: { addFile: (entryName: string, content: Buffer | string) => void },
  workId: string,
  chapterId: string,
): Promise<number> {
  const chapter = await readChapterFile(workId, chapterId);
  if (!chapter) {
    throw new Error("공유할 화를 찾지 못했습니다.");
  }

  const packagePages: LibraryPageRecord[] = [];
  const orderedPages = reorderRecords(chapter.pages, chapter.pageOrder);
  for (const [pageIndex, page] of orderedPages.entries()) {
    packagePages.push(await addPageToShare(zip, chapter.id, page, pageIndex));
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
  return packagePages.length;
}

async function addPageToShare(
  zip: { addFile: (entryName: string, content: Buffer | string) => void },
  chapterId: string,
  page: LibraryPageRecord,
  pageIndex: number,
): Promise<LibraryPageRecord> {
  const imageExt = extname(page.imagePath).toLowerCase() || ".png";
  const packageImagePath = `chapters/${chapterId}/pages/${String(pageIndex + 1).padStart(3, "0")}-${page.id}${imageExt}`;
  await addImageFileToShare({
    zip,
    sourcePath: page.imagePath,
    packagePath: packageImagePath,
    displayName: page.name,
    missingMessage: `원본 이미지를 찾지 못했습니다: ${page.name}`,
  });
  return {
    ...page,
    imagePath: packageImagePath,
    inpaintedImagePath: await addInpaintedPageToShare(
      zip,
      chapterId,
      page,
      pageIndex,
    ),
  };
}

async function addInpaintedPageToShare(
  zip: { addFile: (entryName: string, content: Buffer | string) => void },
  chapterId: string,
  page: LibraryPageRecord,
  pageIndex: number,
): Promise<string | undefined> {
  if (!page.inpaintedImagePath) {
    return undefined;
  }
  const inpaintedExt = extname(page.inpaintedImagePath).toLowerCase() || ".png";
  const packagePath = `chapters/${chapterId}/inpainted/${String(pageIndex + 1).padStart(3, "0")}-${page.id}-inpainted${inpaintedExt}`;
  await addImageFileToShare({
    zip,
    sourcePath: page.inpaintedImagePath,
    packagePath,
    displayName: `${page.name} 인페인팅 결과`,
    missingMessage: `인페인팅 결과 이미지를 찾지 못했습니다: ${page.name}`,
  });
  return packagePath;
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
