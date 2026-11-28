import { shell } from "electron";
import { mkdir, rm, stat } from "node:fs/promises";
import type { ChapterSnapshot, LibraryIndex } from "../../shared/libraryTypes";
import { listLibrary, openChapter } from "../library/libraryReadFacade";
import { logOutputFailure } from "../outputFailureLog";
import {
  createPageExportRenderSession,
  type PageExportRenderSession,
} from "../pageExport";
import type { ImageDecodeFallback } from "../regionCrop";
import { writeBinaryFileAtomically } from "../linkedWorkspace/linkedWorkspacePaths";

export type PageImageExportRepository = {
  listLibrary: () => Promise<LibraryIndex>;
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
};

type PageImageExportRenderPort = {
  createSession: (options: {
    dataRoot: string;
    decodeFallback: ImageDecodeFallback;
  }) => Promise<PageExportRenderSession>;
};

type WriteExportFile = (
  path: string,
  content: Buffer,
  signal?: AbortSignal,
) => Promise<void>;

export type PageImageExportRuntimePort = {
  createDirectory: (path: string, recursive?: boolean) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
  writePng: WriteExportFile;
  writeImage?: WriteExportFile;
  fileExists?: (path: string) => Promise<boolean>;
  writePsd?: WriteExportFile;
  openDirectory: (path: string) => Promise<string>;
  createTimestamp: () => string;
};

type PageImageExportLogger = {
  error: (message: string, detail?: unknown) => void;
};

export type PageImageExportDependencies = {
  repository: PageImageExportRepository;
  renderer: PageImageExportRenderPort;
  runtime: PageImageExportRuntimePort;
  logger: PageImageExportLogger;
};

export const productionPageImageExportDependencies: PageImageExportDependencies =
  {
    repository: {
      listLibrary,
      openChapter,
    },
    renderer: {
      createSession: createPageExportRenderSession,
    },
    runtime: {
      async createDirectory(path, recursive = false) {
        await mkdir(path, recursive ? { recursive: true } : undefined);
      },
      async removeDirectory(path) {
        await rm(path, { recursive: true, force: true });
      },
      writePng: writeExportFile,
      writeImage: writeExportFile,
      writePsd: writeExportFile,
      async fileExists(path) {
        try {
          await stat(path);
          return true;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            return false;
          }
          throw error;
        }
      },
      openDirectory: (path) => shell.openPath(path),
      createTimestamp: () => new Date().toISOString().replace(/[:.]/g, "-"),
    },
    logger: {
      error: logOutputFailure,
    },
  };

function writeExportFile(
  path: string,
  content: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  return writeBinaryFileAtomically(path, content, undefined, { signal });
}
