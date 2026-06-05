import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_IMPORT_IMAGE_BYTES = 256 * 1024 * 1024;
const tempDirs: string[] = [];

describe("library import resource limits", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects oversized regular image files during preview", async () => {
    const rootDir = await createTempLibrary();
    const largeImagePath = join(rootDir, "huge.png");
    await writeFile(largeImagePath, "");
    await truncate(largeImagePath, MAX_IMPORT_IMAGE_BYTES + 1);
    const library = await loadLibrary(rootDir, { decodeEmpty: false });

    await expect(library.previewImages([largeImagePath])).rejects.toThrow(/너무 큽니다/);
  });

  it("rejects image files that cannot be decoded and rolls back the new work", async () => {
    const rootDir = await createTempLibrary();
    const imagePath = join(rootDir, "bad.png");
    await writeFile(imagePath, "not an image");
    const library = await loadLibrary(rootDir, { decodeEmpty: true });

    await expect(
      library.createImport({
        preview: {
          mode: "single",
          sourceKind: "images",
          suggestedWorkTitle: "Decode failure",
          chapters: [
            {
              draftId: "11111111-1111-4111-8111-111111111111",
              title: "1화",
              sourceKind: "images",
              pages: [{ name: "bad.png", sourceKind: "file", sourcePath: imagePath }]
            }
          ]
        },
        target: { mode: "new", title: "Decode failure" },
        selections: [{ draftId: "11111111-1111-4111-8111-111111111111", title: "1화", enabled: true }]
      })
    ).rejects.toThrow(/이미지 파일/);

    expect(existsSync(join(rootDir, "index.json"))).toBe(true);
    expect((await library.listLibrary()).works).toHaveLength(0);
  });

  it("normalizes imported webp pages to png before storing them", async () => {
    const rootDir = await createTempLibrary();
    const imagePath = join(rootDir, "001.webp");
    await writeFile(imagePath, "webp source");
    const library = await loadLibrary(rootDir, { decodeEmpty: false });

    const result = await library.createImport({
      preview: {
        mode: "single",
        sourceKind: "images",
        suggestedWorkTitle: "Webp import",
        chapters: [
          {
            draftId: "22222222-2222-4222-8222-222222222222",
            title: "1화",
            sourceKind: "images",
            pages: [{ name: "001.webp", sourceKind: "file", sourcePath: imagePath }]
          }
        ]
      },
      target: { mode: "new", title: "Webp import" },
      selections: [{ draftId: "22222222-2222-4222-8222-222222222222", title: "1화", enabled: true }]
    });

    const storedPath = result.openedChapter?.pages[0]?.imagePath;
    expect(storedPath).toMatch(/\.png$/);
    expect(storedPath && existsSync(storedPath)).toBe(true);
    expect(await readFile(storedPath!)).toEqual(Buffer.from("converted png"));
  });
});

async function createTempLibrary(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-import-limits-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadLibrary(rootDir: string, options: { decodeEmpty: boolean }): Promise<typeof import("../src/main/library")> {
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: {
      isPackaged: false
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => options.decodeEmpty,
        getSize: () => (options.decodeEmpty ? { width: 0, height: 0 } : { width: 64, height: 96 })
      })
    }
  }));
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      isPackaged: false,
      repoRoot: rootDir,
      executableDir: rootDir,
      resourcesDir: rootDir,
      dataRoot: rootDir,
      settingsPath: join(rootDir, "settings.json"),
      libraryDir: rootDir,
      fontsDir: join(rootDir, "fonts"),
      logsDir: join(rootDir, "logs"),
      logFile: join(rootDir, "logs", "app.log"),
      runtimeDir: join(rootDir, "runtime"),
      toolsDir: join(rootDir, "tools"),
      ocrRuntimeDir: join(rootDir, "ocr-runtime"),
      llamaRuntimeDir: join(rootDir, "tools", "llama"),
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe")
    })
  }));
  vi.doMock("../src/main/simplePageRuntime", () => ({
    decodeImageThroughRuntime: vi.fn(async () => Buffer.from("converted png"))
  }));
  return import("../src/main/library");
}
