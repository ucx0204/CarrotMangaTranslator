import { describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { resolveSourceImageFormat } from "../src/shared/sourceImageFormat";
import { buildPageImageExportRelativePath } from "../src/main/jobs/pageImageExportNaming";
import { resolveLinkedResultPath } from "../src/main/linkedWorkspace/linkedWorkspacePaths";
import type { PageImageExportDependencies } from "../src/main/jobs/pageImageExportPorts";
import type { ChapterSnapshot, LibraryIndex } from "../src/shared/libraryTypes";
import type { PageExportCaptureOptions } from "../src/main/pageExportCapture";
import { editingChapter } from "./mcpEditing.fixture";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";

const sources = [
  ["nested/photo.JPG", "jpeg", "jpg", "none", "photo", "nested/photo.jpg"],
  ["nested/long.JpEg", "jpeg", "jpeg", "none", "long", "nested/long.jpeg"],
  ["image.PNG", "png", "png", "none", "image", "image.png"],
  ["nested/a.WeBp", "webp", "webp", "none", "a", "nested/a.webp"],
  [
    "image.BMP",
    "png",
    "png",
    "unsupported-source-to-png",
    "image",
    "image.png",
  ],
  ["image", "png", "png", "unsupported-source-to-png", "image", "image.png"],
  ["image.", "png", "png", "unsupported-source-to-png", "image", "image.png"],
  [".jpeg", "png", "png", "unsupported-source-to-png", ".jpeg", ".jpeg.png"],
  [".hidden.JPG", "jpeg", "jpg", "none", ".hidden", ".hidden.jpg"],
  [
    "nested/image.jpg.PNG",
    "png",
    "png",
    "none",
    "image.jpg",
    "nested/image.jpg.png",
  ],
] as const;

describe("native source-image format parity", () => {
  it.each(sources)(
    "keeps source policy, preview naming and linked results aligned for %s",
    (source, format, extension, fallback, stem, linkedName) => {
      expect(resolveSourceImageFormat(extname(source))).toEqual({
        format,
        extension,
        fallback,
      });
      expect(
        buildPageImageExportRelativePath({
          chapterIndex: 0,
          chapterTitle: "Chapter",
          pageIndex: 0,
          pageName: source,
          outputFormat: "source",
        }),
      ).toBe(`001-Chapter\\001-${stem}.${extension}`);
      const root = resolve("source-format-fixture");
      const linked = resolveLinkedResultPath({
        rootPath: root,
        sourceRelativePath: source,
        format: "source",
      });
      expect(linked.captureFormat).toBe(format);
      expect(relative(root, linked.path).replaceAll("\\", "/")).toBe(
        `result/${linkedName}`,
      );
    },
  );

  it.each([
    ["camera.JPEG", "jpeg"],
    ["camera.BMP", "png"],
    [undefined, "webp"],
  ] as const)(
    "uses saved source name %s for the extension and display name for the stem",
    (sourceFileName, extension) => {
      expect(
        buildPageImageExportRelativePath({
          chapterIndex: 1,
          chapterTitle: "Title",
          pageIndex: 2,
          pageName: "display.WeBp",
          sourceFileName,
        }),
      ).toBe(`002-Title\\003-display.${extension}`);
    },
  );

  it.each(["png", "jpeg", "webp"] as const)(
    "keeps explicit %s independent of the source extension",
    (format) => {
      const extension = format === "jpeg" ? "jpg" : format;
      const root = resolve("source-format-fixture");
      const linked = resolveLinkedResultPath({
        rootPath: root,
        sourceRelativePath: "nested\\photo.JPEG",
        format,
      });
      expect(linked.captureFormat).toBe(format);
      expect(relative(root, linked.path).replaceAll("\\", "/")).toBe(
        `result/nested/photo.${extension}`,
      );
      expect(
        buildPageImageExportRelativePath({
          chapterIndex: 0,
          chapterTitle: "Chapter",
          pageIndex: 0,
          pageName: "display.PNG",
          sourceFileName: "source.JPEG",
          outputFormat: format,
        }),
      ).toBe(`001-Chapter\\001-display.${extension}`);
    },
  );

  it("preserves explicit PSD preview naming and linked traversal rejection", () => {
    expect(
      buildPageImageExportRelativePath({
        chapterIndex: 0,
        chapterTitle: "Chapter",
        pageIndex: 0,
        pageName: "display.PNG",
        sourceFileName: "source.JPEG",
        outputFormat: "psd",
      }),
    ).toBe("001-Chapter\\001-display.psd");
    expect(() =>
      resolveLinkedResultPath({
        rootPath: resolve("source-format-fixture"),
        sourceRelativePath: "nested/../outside.JPEG",
        format: "source",
      }),
    ).toThrow();
  });

  it.each([false, true])(
    "keeps native capture, exact output bytes and paths with preserveSourceNames=%s",
    async (preserveSourceNames) => {
      const environment = await mcpAppEnvironment();
      try {
        const harness = await nativeHarness(environment.root);
        const before = structuredClone(harness.chapter);
        const request = {
          workId: harness.chapter.workId,
          selections: [{ chapterId: harness.chapter.id, mode: "all" as const }],
          outputFormat: "source" as const,
          preserveSourceNames,
          destinationMode: "fixed" as const,
          jpegQuality: 83,
          webpQuality: 77,
        };
        const preview = await harness.preflight(
          request,
          harness.dependencies.repository,
        );
        expect(preview.sampleRelativePath).toBe("001-Test\\001-display.jpeg");
        const result = await harness.exportImages(
          harness.context,
          request,
          harness.output,
          harness.dependencies,
        );
        expect(result).toMatchObject({ status: "completed", pageCount: 6 });
        for (const [index, expected] of nativeSources.entries()) {
          const page = harness.chapter.pages[index];
          const capture = harness.captures.get(page.id);
          expect(capture).toEqual({
            format: expected.format,
            resolutionMode: "original",
            ...(expected.format === "jpeg"
              ? { quality: 83 }
              : expected.format === "webp"
                ? { quality: 77 }
                : {}),
          });
          const name = preserveSourceNames
            ? expected.preserved
            : `001-Test/${String(index + 1).padStart(3, "0")}-${expected.numbered}`;
          expect(await readFile(join(harness.output, name))).toEqual(
            harness.rendered.get(page.id),
          );
        }
        expect(harness.chapter).toEqual(before);
        expect(harness.writes).toHaveBeenCalledTimes(nativeSources.length);
        expect(harness.context.jobs.current).toBeNull();
      } finally {
        await environment.close();
      }
    },
  );
});

const nativeSources = [
  {
    name: "display.png",
    sourceFileName: "scan.JpEg",
    sourceRelativePath: "nested/scan.JpEg",
    format: "jpeg",
    preserved: "nested/scan.jpeg",
    numbered: "display.jpeg",
  },
  {
    name: "thumb.png",
    sourceFileName: "photo.JPG",
    sourceRelativePath: "nested/photo.JPG",
    format: "jpeg",
    preserved: "nested/photo.jpg",
    numbered: "thumb.jpg",
  },
  {
    name: "page.png",
    sourceFileName: "image.WeBp",
    sourceRelativePath: "other/image.WeBp",
    format: "webp",
    preserved: "other/image.webp",
    numbered: "page.webp",
  },
  {
    name: "fallback.webp",
    sourceFileName: "archive.BMP",
    sourceRelativePath: "other/archive.BMP",
    format: "png",
    preserved: "other/archive.png",
    numbered: "fallback.png",
  },
  {
    name: "no-source.JPEG",
    sourceRelativePath: "nested/no-source.JPEG",
    format: "jpeg",
    preserved: "nested/no-source.jpeg",
    numbered: "no-source.jpeg",
  },
  {
    name: "hide.webp",
    sourceFileName: ".hidden",
    sourceRelativePath: "nested/.hidden",
    format: "png",
    preserved: "nested/.hidden.png",
    numbered: "hide.png",
  },
] as const;

async function nativeHarness(root: string) {
  const [
    { getAppPaths },
    { AppActivityGate },
    { ActiveJobStore },
    jobs,
    selection,
  ] = await Promise.all([
    import("../src/main/appPaths"),
    import("../src/main/appActivityGate"),
    import("../src/main/jobs/activeJob"),
    import("../src/main/jobs/pageImageExportJobs"),
    import("../src/main/jobs/pageImageExportSelection"),
  ]);
  const chapter = nativeChapter(root);
  const captures = new Map<string, PageExportCaptureOptions | undefined>();
  const rendered = new Map<string, Buffer>();
  const writes = vi.fn(async (path: string, bytes: Buffer) =>
    writeFile(path, bytes),
  );
  const dependencies: PageImageExportDependencies = {
    repository: {
      listLibrary: async () => libraryFor(chapter),
      openChapter: async () => structuredClone(chapter),
    },
    renderer: {
      createSession: async () => ({
        async renderPage(page, options) {
          captures.set(page.id, options);
          // Only the renderer boundary is supplied. Verify its bytes are forwarded exactly.
          const bytes =
            options?.format === "png"
              ? Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLPsAAAAASUVORK5CYII=",
                  "base64",
                )
              : Buffer.from(`${options?.format}:${page.id}`);
          rendered.set(page.id, bytes);
          return bytes;
        },
        close: vi.fn(),
      }),
    },
    runtime: {
      createDirectory: async (path, recursive = false) => {
        await mkdir(path, { recursive });
      },
      removeDirectory: async (path) =>
        rm(path, { recursive: true, force: true }),
      writePng: writes,
      writeImage: writes,
      openDirectory: async () => "",
      createTimestamp: () => "source-format-fixture",
    },
    logger: { error: vi.fn() },
  };
  return {
    chapter,
    captures,
    rendered,
    writes,
    dependencies,
    output: join(root, "output"),
    exportImages: jobs.exportPageImages,
    preflight: selection.preflightPageImageExport,
    context: {
      appPaths: getAppPaths(),
      jobs: new ActiveJobStore(undefined, new AppActivityGate()),
      getMainWindow: () => null,
      decodeImage: async () => null,
    },
  };
}

function nativeChapter(root: string): ChapterSnapshot {
  const chapter = editingChapter();
  const template = chapter.pages[0];
  chapter.pages = nativeSources.map((source, index) => ({
    ...structuredClone(template),
    id: `page-${index + 1}`,
    name: source.name,
    ...("sourceFileName" in source
      ? { sourceFileName: source.sourceFileName }
      : {}),
    sourceRelativePath: source.sourceRelativePath,
    imagePath: join(root, `original-${index}.png`),
  }));
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  return chapter;
}

function libraryFor(chapter: ChapterSnapshot): LibraryIndex {
  return {
    workOrder: [chapter.workId],
    works: [
      {
        id: chapter.workId,
        title: "Work",
        chapterOrder: [chapter.id],
        chapters: [
          {
            id: chapter.id,
            workId: chapter.workId,
            title: chapter.title,
            status: chapter.status,
            pageCount: chapter.pages.length,
            createdAt: chapter.createdAt,
            updatedAt: chapter.updatedAt,
          },
        ],
        createdAt: chapter.createdAt,
        updatedAt: chapter.updatedAt,
      },
    ],
  };
}
