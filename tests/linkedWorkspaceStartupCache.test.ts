import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rename,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { LinkedWorkspaceStartupCache } from "../src/main/linkedWorkspace/linkedWorkspaceStartupCache";
import { makeChapter } from "./fixtures/linkedWorkspace";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
vi.mock("electron", () => ({
  app: { getVersion: () => "test" },
  shell: { openPath: async () => "" },
}));
import { LinkedWorkspaceSyncService } from "../src/main/linkedWorkspace/linkedWorkspaceSyncService";

const roots: string[] = [];
const services: LinkedWorkspaceSyncService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) {
    if (
      !root.startsWith(join(await realpath(tmpdir()), "linked-startup-cache-"))
    )
      throw new Error("Unexpected test root");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  // macOS aliases /var to /private/var. The cache intentionally rejects
  // symlink ancestors, so the unchanged-path fixture uses its real directory.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "linked-startup-cache-")),
  );
  roots.push(root);
  const chapter = makeChapter();
  chapter.pages[0].imagePath = join(root, "source.png");
  await writeFile(chapter.pages[0].imagePath, "source");
  const chapterPath = join(root, "chapter.json");
  await writeFile(chapterPath, JSON.stringify(chapter));
  const openChapter = vi.fn(async (): Promise<ChapterSnapshot> =>
    JSON.parse(await readFile(chapterPath, "utf8")),
  );
  const reportError = vi.fn();
  const create = () => {
    const service = new LinkedWorkspaceSyncService({
      dataRoot: root,
      startupCache: new LinkedWorkspaceStartupCache(
        root,
        () => chapterPath,
        reportError,
      ),
      jobs: { hasActive: false } as never,
      decodeImage: async () => null,
      getMainWindow: () => null,
      reportError,
      dependencies: {
        openChapter,
        listLibrary: async () => ({
          workOrder: [chapter.workId],
          works: [
            {
              id: chapter.workId,
              title: "test",
              chapterOrder: [chapter.id],
              chapters: [{ ...chapter, pageCount: 1 }],
              createdAt: chapter.createdAt,
              updatedAt: chapter.updatedAt,
            },
          ],
        }),
        updatePagesAfterInpainting: vi.fn(),
        createPageExportRenderSession: async () => ({
          renderPage: async () => Buffer.from("result"),
          close: () => {},
          cancel: () => {},
        }),
      },
    });
    services.push(service);
    return service;
  };
  const initial = create();
  await initial.initialize();
  await initial.connect({
    workId: chapter.workId,
    chapterId: chapter.id,
    output: DEFAULT_RASTER_EXPORT_SETTINGS,
  });
  await initial.viewResults({ chapterId: chapter.id });
  await initial.dispose();
  const baseline = create();
  await baseline.initialize();
  await baseline.dispose();
  openChapter.mockClear();
  return { root, chapter, chapterPath, openChapter, create, reportError };
}

it("skips only the unchanged idle connection audit across service restarts", async () => {
  const f = await fixture();
  const registryBefore = await readFile(
    join(f.root, "linked-workspaces.json"),
    "utf8",
  );
  const restored = f.create();
  await restored.initialize();
  expect(f.openChapter).not.toHaveBeenCalled();
  expect(restored.getStatus(f.chapter.id)).toMatchObject({
    state: "idle",
    pendingCount: 0,
  });
  expect(await readFile(join(f.root, "linked-workspaces.json"), "utf8")).toBe(
    registryBefore,
  );
  expect(await readFile(f.chapter.pages[0].imagePath, "utf8")).toBe("source");
});

it.each(["chapter", "source", "result", "missing-result", "corrupt-cache"])(
  "runs the full audit after %s changes",
  async (kind) => {
    const f = await fixture();
    if (kind === "chapter") {
      f.chapter.pages[0].blocks[0].translatedText = "edited";
      await writeFile(f.chapterPath, JSON.stringify(f.chapter));
    } else if (kind === "corrupt-cache") {
      await writeFile(
        join(f.root, "cache", "linked-workspace-startup-v1.json"),
        "broken",
      );
    } else {
      const registry = JSON.parse(
        await readFile(join(f.root, "linked-workspaces.json"), "utf8"),
      );
      const record = registry.records[0];
      const path =
        kind === "source"
          ? f.chapter.pages[0].imagePath
          : join(
              record.rootPath,
              record.artifacts[f.chapter.pages[0].id].result.path,
            );
      if (kind === "missing-result") await unlink(path);
      else {
        const info = await stat(path);
        await writeFile(path, kind === "source" ? "edited" : "modify");
        await utimes(path, info.atime, info.mtime);
      }
    }
    const restored = f.create();
    await restored.initialize();
    expect(f.openChapter).toHaveBeenCalled();
  },
);

it("does not cache a race and falls back when an optional cache cannot be written", async () => {
  const f = await fixture();
  const registry = JSON.parse(
    await readFile(join(f.root, "linked-workspaces.json"), "utf8"),
  );
  const cache = new LinkedWorkspaceStartupCache(
    f.root,
    () => f.chapterPath,
    f.reportError,
  );
  const before = await cache.capture(registry.records[0]);
  await writeFile(f.chapterPath, "changed");
  cache.remember(
    registry.records[0].id,
    before,
    await cache.capture(registry.records[0]),
  );
  await cache.save();
  await cache.load();
  expect(cache.matches(registry.records[0].id, before)).toBe(false);
  const cachePath = join(f.root, "cache", "linked-workspace-startup-v1.json");
  await unlink(cachePath);
  await mkdir(cachePath);
  await expect(cache.save()).resolves.toBeUndefined();
  expect(f.reportError).toHaveBeenCalled();
});

it("always reconciles a persisted queue even when its connection has a cached audit", async () => {
  const f = await fixture();
  const registry = JSON.parse(
    await readFile(join(f.root, "linked-workspaces.json"), "utf8"),
  );
  const record = registry.records[0];
  const pageId = f.chapter.pages[0].id;
  await writeFile(
    join(f.root, "linked-sync-queue.json"),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          connectionId: record.id,
          chapterId: f.chapter.id,
          pageId,
          visualRevision: record.publishedRevisions[pageId],
          mirrorRevision: record.publishedMirrorRevisions[pageId],
          priority: 20,
          attempts: 0,
          nextRetryAt: Date.now() + 10000,
          queuedAt: Date.now(),
        },
      ],
    }),
  );
  const restored = f.create();
  await restored.initialize();
  expect(f.openChapter).toHaveBeenCalled();
  expect(restored.getStatus(f.chapter.id).pendingCount).toBe(0);
});

it("refuses cached audits through a substituted directory junction", async () => {
  const f = await fixture();
  const registry = JSON.parse(
    await readFile(join(f.root, "linked-workspaces.json"), "utf8"),
  );
  const record = registry.records[0];
  const originalDirectory = join(record.rootPath, "originals");
  const moved = join(f.root, "preserved-originals");
  await rename(originalDirectory, moved);
  await symlink(
    moved,
    originalDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    const cache = new LinkedWorkspaceStartupCache(
      f.root,
      () => f.chapterPath,
      f.reportError,
    );
    expect(await cache.capture(record)).toBeNull();
  } finally {
    // Detach the link before the fixture's recursive cleanup can run.
    await unlink(originalDirectory);
    await rename(moved, originalDirectory);
  }
});
