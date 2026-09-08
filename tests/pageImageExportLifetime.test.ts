import { describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppActivityGate } from "../src/main/appActivityGate";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { exportPageImages } from "../src/main/jobs/pageImageExportJobs";
import type { InpaintingJobContext } from "../src/main/jobs/inpaintingJobTypes";
import type { PageImageExportDependencies } from "../src/main/jobs/pageImageExportPorts";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  shell: { openPath: vi.fn(async () => "") },
}));

describe("page image export lifetime cleanup", () => {
  it.each(
    (["replace", "skip", "cancel"] as const).flatMap((collisionPolicy) =>
      (["source", "png", "jpeg", "webp"] as const).map((outputFormat) => ({
        collisionPolicy,
        outputFormat,
      })),
    ),
  )(
    "keeps mixed-extension same-stem pages distinct for $outputFormat with $collisionPolicy",
    async ({ collisionPolicy, outputFormat }) => {
      const outputDir = await mkdtemp(join(tmpdir(), "page-image-collision-"));
      const pages = ["001.png", "001.jpg"].map((name, index) => ({
        ...makePage(`page-${index + 1}`),
        name,
        sourceFileName: name,
        sourceRelativePath: `nested/${name}`,
      }));
      const chapter = makeChapter(pages);
      // The renderer boundary supplies two distinguishable raster buffers.
      const rendered = pages.map((_, index) => fakePng(10 + index, 10));
      const allRendering = createDeferred<void>();
      let started = 0;
      const dependencies = makeDependencies(chapter, {
        async renderPage(page) {
          started += 1;
          if (started === pages.length) allRendering.resolve();
          await allRendering.promise;
          const content =
            rendered[pages.findIndex((candidate) => candidate.id === page.id)];
          if (!content) throw new Error("missing test render content");
          return content;
        },
      });
      const writeImage = vi.fn(async (path: string, content: Buffer) =>
        writeFile(path, content),
      );
      dependencies.runtime = {
        ...dependencies.runtime,
        async createDirectory(path, recursive = false) {
          await mkdir(path, { recursive });
        },
        writeImage,
        async fileExists(path) {
          return stat(path).then(
            () => true,
            () => false,
          );
        },
      };
      try {
        const result = await exportPageImages(
          makeContext(),
          {
            ...requestFor(chapter.id),
            outputFormat,
            preserveSourceNames: true,
            destinationMode: "fixed",
            collisionPolicy,
          },
          outputDir,
          dependencies,
        );
        expect(result).toMatchObject({ status: "completed", pageCount: 2 });
        const names = await readdir(join(outputDir, "nested"));
        expect(names).toHaveLength(2);
        expect(
          new Set(writeImage.mock.calls.map(([path]) => path.toLowerCase()))
            .size,
        ).toBe(2);
        const contents = await Promise.all(
          names.map((name) => readFile(join(outputDir, "nested", name))),
        );
        expect(
          contents.map((content) => content.toString("hex")).sort(),
        ).toEqual(rendered.map((content) => content.toString("hex")).sort());
        if (outputFormat === "source")
          expect(names.sort()).toEqual(["001.jpg", "001.png"]);
        else
          expect(
            names.every((name) =>
              name.endsWith(
                outputFormat === "jpeg" ? ".jpg" : `.${outputFormat}`,
              ),
            ),
          ).toBe(true);
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps cleanup pending until an immediately cancelled outer export finishes", async () => {
    const chapter = makeChapter([makePage("page-1")]);
    const library = makeLibrary(chapter);
    const selectionGate = createDeferred<LibraryIndex>();
    const dependencies = makeDependencies(chapter, {
      listLibrary: () => selectionGate.promise,
    });
    const context = makeContext();

    const exporting = exportPageImages(
      context,
      requestFor(chapter.id),
      "C:\\exports",
      dependencies,
    );
    await vi.waitFor(() => {
      expect(context.jobs.current?.kind).toBe("page-export");
    });
    const job = context.jobs.current;
    if (!job) {
      throw new Error("Expected active page export job");
    }
    job.abortController.abort();
    let cleanupSettled = false;
    const cleanup = context.jobs.runCleanup(job, "cancel").then(() => {
      cleanupSettled = true;
    });

    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    selectionGate.resolve(library);

    await expect(exporting).resolves.toEqual({ status: "cancelled" });
    await cleanup;
    expect(cleanupSettled).toBe(true);
    expect(context.jobs.current).toBeNull();
    expect(dependencies.renderer.createSession).not.toHaveBeenCalled();
    expect(dependencies.runtime.createDirectory).not.toHaveBeenCalled();
  });

  it("waits for failed-output cleanup, render-session close, and outer completion", async () => {
    const chapter = makeChapter([makePage("page-1")]);
    const renderGate = createDeferred<Buffer>();
    const close = vi.fn();
    const removeDirectory = vi.fn(async () => undefined);
    const dependencies = makeDependencies(chapter, {
      renderPage: () => renderGate.promise,
      close,
      removeDirectory,
    });
    const context = makeContext();

    const exporting = exportPageImages(
      context,
      requestFor(chapter.id),
      "C:\\exports",
      dependencies,
    );
    await vi.waitFor(() => {
      expect(dependencies.renderer.createSession).toHaveBeenCalledTimes(1);
      expect(context.jobs.current?.kind).toBe("page-export");
    });
    const job = context.jobs.current;
    if (!job) {
      throw new Error("Expected active page export job");
    }
    job.abortController.abort();
    let cleanupSettled = false;
    const cleanup = context.jobs.runCleanup(job, "app-quit").then(() => {
      cleanupSettled = true;
    });

    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();

    renderGate.resolve(Buffer.from("png"));
    await expect(exporting).resolves.toEqual({ status: "cancelled" });
    await cleanup;

    expect(removeDirectory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanupSettled).toBe(true);
    expect(context.jobs.current).toBeNull();
  });

  it("finishes normally without awaiting its own cleanup boundary", async () => {
    const chapter = makeChapter([makePage("page-1")]);
    const dependencies = makeDependencies(chapter);
    const context = makeContext();

    await expect(
      exportPageImages(
        context,
        requestFor(chapter.id),
        "C:\\exports",
        dependencies,
      ),
    ).resolves.toMatchObject({
      status: "completed",
      pageCount: 1,
    });

    expect(context.jobs.current).toBeNull();
    expect(dependencies.runtime.writePng).toHaveBeenCalledTimes(1);
  });
});

function fakePng(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(13, 8);
  Buffer.from("IHDR", "ascii").copy(png, 12);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function makeContext(): InpaintingJobContext {
  const activityGate = new AppActivityGate();
  return {
    appPaths: {
      isPackaged: false,
      repoRoot: "C:\\test",
      executableDir: "C:\\test",
      resourcesDir: "C:\\test\\resources",
      dataRoot: "C:\\test\\data",
      settingsPath: "C:\\test\\data\\settings.json",
      libraryDir: "C:\\test\\data\\library",
      fontsDir: "C:\\test\\data\\fonts",
      logsDir: "C:\\test\\data\\logs",
      logFile: "C:\\test\\data\\logs\\app.log",
      runtimeDir: "C:\\test\\runtime",
      toolsDir: "C:\\test\\tools",
      ocrRuntimeDir: "C:\\test\\ocr",
      llamaRuntimeDir: "C:\\test\\llama",
      llamaServerPath: "C:\\test\\llama\\server.exe",
    },
    jobs: new ActiveJobStore(undefined, activityGate),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
}

function makeDependencies(
  chapter: ChapterSnapshot,
  overrides: {
    listLibrary?: () => Promise<LibraryIndex>;
    renderPage?: (page: MangaPage) => Promise<Buffer>;
    close?: () => void;
    removeDirectory?: (path: string) => Promise<void>;
  } = {},
): PageImageExportDependencies {
  const library = makeLibrary(chapter);
  const renderPage = vi.fn(
    overrides.renderPage ?? (async (_page: MangaPage) => fakePng(10, 10)),
  );
  const close = vi.fn(overrides.close ?? (() => undefined));
  return {
    repository: {
      listLibrary: vi.fn(overrides.listLibrary ?? (async () => library)),
      openChapter: vi.fn(async () => chapter),
    },
    renderer: {
      createSession: vi.fn(async () => ({
        renderPage,
        close,
      })),
    },
    runtime: {
      createDirectory: vi.fn(async () => undefined),
      removeDirectory: vi.fn(
        overrides.removeDirectory ?? (async () => undefined),
      ),
      writePng: vi.fn(async () => undefined),
      openDirectory: vi.fn(async () => ""),
      createTimestamp: vi.fn(() => "2026-08-07T09-00-00-000Z"),
    },
    logger: {
      error: vi.fn(),
    },
  };
}

function makeLibrary(chapter: ChapterSnapshot): LibraryIndex {
  return {
    workOrder: ["work-1"],
    works: [
      {
        id: "work-1",
        title: "Work",
        chapterOrder: [chapter.id],
        chapters: [
          {
            id: chapter.id,
            workId: "work-1",
            title: chapter.title,
            status: chapter.status,
            pageCount: chapter.pages.length,
            createdAt: chapter.createdAt,
            updatedAt: chapter.updatedAt,
          },
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function makeChapter(pages: MangaPage[]): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "Chapter 1",
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(id: string): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `C:\\images\\${id}.png`,
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function requestFor(chapterId: string) {
  return {
    workId: "work-1",
    selections: [{ chapterId, mode: "all" as const }],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
