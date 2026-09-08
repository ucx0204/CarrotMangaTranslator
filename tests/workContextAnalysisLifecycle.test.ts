import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: null, stdout: string) => void,
  ) => callback(null, ""),
}));

const timestamp = "2026-09-08T00:00:00.000Z";
let paths: AppPaths;
let events: string[];
let persistedAtDispose: unknown;

beforeEach(async () => {
  vi.resetModules();
  const directory = await mkdtemp(
    join(tmpdir(), "manga-analysis-lifetime-test-"),
  );
  paths = isolatedPaths(directory);
  events = [];
  persistedAtDispose = undefined;
  vi.doMock("../src/main/appPaths", () => ({ getAppPaths: () => paths }));
  vi.doMock("../src/main/translationRuntime", () => ({
    loadTranslationRuntimePort: () => ({
      startEndpointSession: async () => ({
        handle: {
          baseUrl: "https://codex.invalid/v1",
          child: null,
          provider: "openai-codex",
          startedByScript: false,
        },
        dispose: async () => {
          events.push("dispose");
          const { getWorkStyleGuide } = await import("../src/main/library");
          persistedAtDispose = await getWorkStyleGuide("work-1");
        },
      }),
    }),
  }));
  await seedAnalysisLibrary();
  const { resolveDefaultAppSettings } = await import("../src/main/appSettings");
  const settings = resolveDefaultAppSettings({}, null);
  settings.modelProvider = "openai-codex";
  await writeFile(paths.settingsPath, JSON.stringify(settings), "utf8");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.doUnmock("../src/main/appPaths");
  vi.doUnmock("../src/main/translationRuntime");
  vi.resetModules();
  await rm(paths.dataRoot, { recursive: true, force: true });
});

describe("single-chapter AI context endpoint lifetime", () => {
  it.each(["success", "rejection", "cancellation"] as const)(
    "disposes only after the pending request settles on %s",
    async (outcome) => {
      const controller = new AbortController();
      const started = deferred<void>();
      const response = deferred<Response>();
      const requestError = new Error("provider request rejected");
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (url, init) => {
          expect(String(url)).toBe("https://codex.invalid/v1/responses");
          events.push("request-started");
          const onAbort = () => response.reject(init?.signal?.reason);
          init?.signal?.addEventListener("abort", onAbort, { once: true });
          started.resolve();
          try {
            return await response.promise;
          } finally {
            init?.signal?.removeEventListener("abort", onAbort);
            events.push("request-settled");
          }
        }),
      );
      const { analyzeWorkContextWithAi } =
        await import("../src/main/workContextAnalysis");
      const analysis = analyzeWorkContextWithAi(
        { chapterId: "chapter-1", scope: "chapter" },
        controller.signal,
      );
      // Observe rejections immediately, including failure before provider startup.
      const settled = analysis.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await Promise.race([
        started.promise,
        settled.then((result) => {
          if (result.error) throw result.error;
          throw new Error("Analysis completed before provider startup");
        }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pendingEvents = [...events];
      if (outcome === "success") response.resolve(analysisResponse());
      else if (outcome === "rejection") response.reject(requestError);
      else controller.abort(new DOMException("Canceled", "AbortError"));
      const result = await settled;
      expect(pendingEvents).toEqual(["request-started"]);
      expect(events).toEqual(["request-started", "request-settled", "dispose"]);
      if (outcome === "success") {
        expect(result.error).toBeUndefined();
        expect(result.value?.counts.glossaryAdded).toBe(1);
        expect(persistedAtDispose).toMatchObject({
          glossary: [
            expect.objectContaining({ source: "魔王", target: "마왕" }),
          ],
        });
      } else {
        expect(result.value).toBeUndefined();
        if (outcome === "rejection") {
          expect(result.error).toMatchObject({ cause: requestError });
        } else {
          expect(result.error).toBe(controller.signal.reason);
        }
        expect(persistedAtDispose).toMatchObject({ glossary: [] });
        const memoryPath = join(
          paths.libraryDir,
          "works",
          "work-1",
          "chapters",
          "chapter-1",
          "story-memory.json",
        );
        await expect(readFile(memoryPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );
});

function analysisResponse(): Response {
  const output = JSON.stringify({
    glossary: [{ source: "魔王", target: "마왕", category: "term" }],
    characters: [],
    pageSummaries: [],
  });
  return new Response(
    [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: output })}`,
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"test","status":"completed"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );
}

function isolatedPaths(directory: string): AppPaths {
  return {
    isPackaged: false,
    repoRoot: directory,
    dataRoot: directory,
    executableDir: directory,
    resourcesDir: directory,
    libraryDir: join(directory, "library"),
    settingsPath: join(directory, "settings.json"),
    fontsDir: join(directory, "fonts"),
    logsDir: join(directory, "logs"),
    logFile: join(directory, "logs", "app.log"),
    runtimeDir: join(directory, "runtime"),
    toolsDir: join(directory, "tools"),
    ocrRuntimeDir: join(directory, "ocr-runtime"),
    llamaRuntimeDir: join(directory, "llama"),
    llamaServerPath: join(directory, "llama", "llama-server.exe"),
  };
}

async function seedAnalysisLibrary(): Promise<void> {
  const work: LibraryWork = {
    id: "work-1",
    title: "작품",
    chapterOrder: ["chapter-1"],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const chapter: LibraryChapter = {
    id: "chapter-1",
    workId: work.id,
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: ["page-1"],
    pages: [
      {
        id: "page-1",
        name: "001.png",
        imagePath: join(
          paths.libraryDir,
          "works/work-1/chapters/chapter-1/pages/001.png",
        ),
        width: 100,
        height: 100,
        analysisStatus: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
        blocks: [
          {
            id: "block-1",
            type: "nonsolid",
            bbox: { x: 1, y: 1, w: 10, h: 10 },
            sourceText: "魔王だ",
            translatedText: "마왕이다",
            confidence: 1,
            sourceDirection: "horizontal",
            renderDirection: "horizontal",
            fontSizePx: 16,
            lineHeight: 1.2,
            textAlign: "center",
            textColor: "#000000",
            backgroundColor: "#ffffff",
            opacity: 1,
          },
        ],
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const fixtures: Array<[string, unknown]> = [
    ["index.json", { workOrder: [work.id] }],
    ["works/work-1/work.json", work],
    ["works/work-1/chapters/chapter-1/chapter.json", chapter],
  ];
  for (const [relativePath, value] of fixtures) {
    const filePath = join(paths.libraryDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value), "utf8");
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
