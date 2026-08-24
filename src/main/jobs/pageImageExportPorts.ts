import { shell } from "electron";
import { mkdir, rm, stat } from "node:fs/promises";
import type { ChapterSnapshot, LibraryIndex } from "../../shared/libraryTypes";
import { listLibrary, openChapter } from "../library/libraryReadFacade";
import { logError } from "../logger";
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

export type PageImageExportRuntimePort = {
  createDirectory: (path: string, recursive?: boolean) => Promise<void>;
  removeDirectory: (path: string) => Promise<void>;
  writePng: (path: string, content: Buffer) => Promise<void>;
  writeImage?: (path: string, content: Buffer) => Promise<void>;
  fileExists?: (path: string) => Promise<boolean>;
  writePsd?: (path: string, content: Buffer) => Promise<void>;
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
      async writePng(path, content) {
        await writeBinaryFileAtomically(path, content);
      },
      async writeImage(path, content) {
        await writeBinaryFileAtomically(path, content);
      },
      async writePsd(path, content) {
        await writeBinaryFileAtomically(path, content);
      },
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
      error: logError,
    },
  };
