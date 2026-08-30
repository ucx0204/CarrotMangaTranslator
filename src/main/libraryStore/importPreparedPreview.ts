import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type { PreparedImportPreview } from "../../shared/importTypes";
import { tMain } from "./localization";
import {
  isRarArchivePath,
  isZipArchivePath,
  listRarFiles,
} from "./importSources";
import { stageImportSource } from "./importSourceRunner";
import type { ImportSourceProgress } from "./importSourceRunner";
import { previewZip, previewZipFolder } from "./importWorkflow";

export async function preparePdfImportPreview(
  pdfPath: string,
  signal?: AbortSignal,
  onProgress?: (progress: ImportSourceProgress) => void,
): Promise<PreparedImportPreview> {
  return prepareNativeImportPreview("pdf", pdfPath, signal, onProgress);
}

export async function prepareArchiveImportPreview(
  archivePath: string,
  signal?: AbortSignal,
  onProgress?: (progress: ImportSourceProgress) => void,
): Promise<PreparedImportPreview> {
  if (isZipArchivePath(archivePath)) {
    return { preview: await previewZip(archivePath) };
  }
  if (isRarArchivePath(archivePath)) {
    return prepareNativeImportPreview("rar", archivePath, signal, onProgress);
  }
  throw new Error(
    tMain("import.errors.unsupportedArchive", {
      file: basename(archivePath),
    }),
  );
}

export async function prepareArchiveFolderImportPreview(
  folderPath: string,
  signal?: AbortSignal,
  onProgress?: (progress: ImportSourceProgress) => void,
): Promise<PreparedImportPreview> {
  const basePreview = await previewZipFolder(folderPath);
  const preparedRarPreviews: PreparedImportPreview[] = [];
  try {
    for (const rarPath of await listRarFiles(folderPath)) {
      preparedRarPreviews.push(
        await prepareNativeImportPreview("rar", rarPath, signal, onProgress),
      );
    }
  } catch (error) {
    await cleanupPreparedPreviews(preparedRarPreviews);
    throw error;
  }

  const chapters = [
    ...basePreview.chapters,
    ...preparedRarPreviews.flatMap((prepared) => prepared.preview.chapters),
  ].sort((left, right) =>
    left.title.localeCompare(right.title, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  const cleanup =
    preparedRarPreviews.length > 0
      ? () => cleanupPreparedPreviews(preparedRarPreviews)
      : undefined;
  return {
    preview: {
      ...basePreview,
      chapters,
    },
    cleanup,
  };
}

async function prepareNativeImportPreview(
  kind: "pdf" | "rar",
  sourcePath: string,
  signal?: AbortSignal,
  onProgress?: (progress: ImportSourceProgress) => void,
): Promise<PreparedImportPreview> {
  const staged = await stageImportSource(kind, sourcePath, {
    signal,
    onProgress,
  });
  const title = basename(sourcePath, extname(sourcePath));
  return {
    preview: {
      mode: "single",
      sourceKind: kind,
      suggestedWorkTitle: tMain("import.defaultWorkTitle"),
      chapters: [
        {
          draftId: randomUUID(),
          title,
          sourceKind: kind,
          pages: staged.pages.map((page, index) => ({
            name: kind === "pdf" ? pdfPageName(title, index) : page.name,
            sourcePath: page.filePath,
            sourceKind: "file" as const,
          })),
        },
      ],
    },
    cleanup: staged.cleanup,
  };
}

function pdfPageName(title: string, index: number): string {
  const suffix = "-" + String(index + 1).padStart(3, "0") + ".png";
  return title.slice(0, 260 - suffix.length) + suffix;
}

async function cleanupPreparedPreviews(
  previews: PreparedImportPreview[],
): Promise<void> {
  const results = await Promise.allSettled(
    previews.map(async (preview) => preview.cleanup?.()),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Prepared import preview cleanup failed.",
    );
  }
}
