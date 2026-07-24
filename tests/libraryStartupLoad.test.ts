import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("library startup load", () => {
  it("returns every stored work and chapter in index order", async () => {
    const fixture = await createLibraryFixture(18, {
      includeMissingWorkReference: true,
    });
    vi.doMock("../src/main/appPaths", () => ({
      getAppPaths: () => ({ libraryDir: fixture.libraryDir }),
    }));
    const { listLibrary } =
      await import("../src/main/library/libraryReadFacade");

    const library = await listLibrary();

    expect(library.workOrder).toEqual(fixture.workIds);
    expect(library.works.map((work) => work.id)).toEqual(fixture.workIds);
    expect(library.works).toHaveLength(18);
    expect(library.works.flatMap((work) => work.chapters)).toHaveLength(18);
    expect(library.works.every((work) => work.chapters.length === 1)).toBe(
      true,
    );
  });

  it("finds the first indexed owner and returns null for a missing chapter", async () => {
    const fixture = await createLibraryFixture(3, {
      shareChapterId: true,
    });
    vi.doMock("../src/main/appPaths", () => ({
      getAppPaths: () => ({ libraryDir: fixture.libraryDir }),
    }));
    const { findChapterLocation } =
      await import("../src/main/libraryStore/libraryFiles");

    await expect(
      findChapterLocation(fixture.chapterIds[0] ?? ""),
    ).resolves.toEqual({
      workId: fixture.workIds[0],
      chapterId: fixture.chapterIds[0],
    });
    await expect(findChapterLocation(randomUUID())).resolves.toBeNull();
  });

  it("keeps a chapter visible when only its page payload is corrupt", async () => {
    const fixture = await createLibraryFixture(2);
    const workId = fixture.workIds[0];
    const chapterId = fixture.chapterIds[0];
    if (!workId || !chapterId) {
      throw new Error("Expected the first fixture chapter");
    }
    const pageId = randomUUID();
    await writeJson(
      join(
        fixture.libraryDir,
        "works",
        workId,
        "chapters",
        chapterId,
        "chapter.json",
      ),
      {
        id: chapterId,
        workId,
        title: "Visible damaged chapter",
        sourceKind: "images",
        status: "failed",
        pageOrder: [pageId],
        pages: [{ id: pageId, invalidPagePayload: true }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    );
    vi.doMock("../src/main/appPaths", () => ({
      getAppPaths: () => ({ libraryDir: fixture.libraryDir }),
    }));
    const { listLibrary, openChapter } =
      await import("../src/main/library/libraryReadFacade");

    const library = await listLibrary();

    expect(library.works).toHaveLength(2);
    expect(library.works[0]?.chapters[0]).toMatchObject({
      id: chapterId,
      pageCount: 1,
      status: "failed",
      title: "Visible damaged chapter",
    });
    await expect(openChapter(chapterId)).rejects.toThrow(
      /보관함 파일 형식이 올바르지 않습니다/,
    );
  });
});

type LibraryFixture = {
  chapterIds: string[];
  libraryDir: string;
  workIds: string[];
};

async function createLibraryFixture(
  workCount: number,
  options: {
    includeMissingWorkReference?: boolean;
    shareChapterId?: boolean;
  } = {},
): Promise<LibraryFixture> {
  const root = await mkdtemp(join(tmpdir(), "manga-library-startup-"));
  temporaryRoots.push(root);
  const workIds = Array.from({ length: workCount }, () => randomUUID());
  const sharedChapterId = options.shareChapterId ? randomUUID() : null;
  const chapterIds = workIds.map(() => sharedChapterId ?? randomUUID());
  const createdAt = "2026-01-01T00:00:00.000Z";
  await Promise.all(
    workIds.map(async (workId, index) => {
      const chapterId = chapterIds[index];
      if (!chapterId) {
        throw new Error(`Missing chapter id for fixture work ${workId}`);
      }
      const workRoot = join(root, "works", workId);
      const chapterRoot = join(workRoot, "chapters", chapterId);
      await mkdir(chapterRoot, { recursive: true });
      await Promise.all([
        writeJson(join(workRoot, "work.json"), {
          id: workId,
          title: `Work ${index + 1}`,
          chapterOrder: [chapterId],
          createdAt,
          updatedAt: createdAt,
        }),
        writeJson(join(chapterRoot, "chapter.json"), {
          id: chapterId,
          workId,
          title: `Chapter ${index + 1}`,
          sourceKind: "images",
          status: "idle",
          pageOrder: [],
          pages: [],
          createdAt,
          updatedAt: createdAt,
        }),
      ]);
    }),
  );
  const workOrder = options.includeMissingWorkReference
    ? [workIds[0], randomUUID(), ...workIds.slice(1)]
    : workIds;
  await writeJson(join(root, "index.json"), { workOrder });
  return { chapterIds, libraryDir: root, workIds };
}

function writeJson(path: string, payload: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");
}
