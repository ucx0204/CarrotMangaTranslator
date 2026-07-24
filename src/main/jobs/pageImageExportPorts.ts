import { shell } from "electron";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { ChapterSnapshot, LibraryIndex } from "../../shared/libraryTypes";
import { listLibrary, openChapter } from "../library/libraryReadFacade";
import { logError } from "../logger";
import {
  createPageExportRenderSession,
  type PageExportRenderSession,
} from "../pageExport";
import type { ImageDecodeFallback } from "../regionCrop";

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
        await writeFile(path, content);
      },
      openDirectory: (path) => shell.openPath(path),
      createTimestamp: () => new Date().toISOString().replace(/[:.]/g, "-"),
    },
    logger: {
      error: logError,
    },
  };
