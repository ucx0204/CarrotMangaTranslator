import type { ChapterSnapshot, LibraryIndex } from "../../shared/libraryTypes";

export type McpPageWindow = { offset: number; limit: number };

export type McpLibraryReadPort = {
  listLibrary: () => Promise<LibraryIndex>;
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
};

/** Read-only use cases. Storage locks remain owned by the existing library facade. */
export class McpLibraryReadService {
  private readonly library: McpLibraryReadPort;

  constructor(library: McpLibraryReadPort) {
    this.library = library;
  }

  async listWorks(window: McpPageWindow, query = "") {
    const library = await this.library.listLibrary();
    const search = query.toLowerCase();
    const works = library.works.filter((work) =>
      work.title.toLowerCase().includes(search),
    );
    return {
      ...pageWindow(works.length, window),
      works: works
        .slice(window.offset, window.offset + window.limit)
        .map((work) => ({
          id: work.id,
          title: work.title,
          chapterCount: work.chapters.length,
          updatedAt: work.updatedAt,
        })),
    };
  }

  async listChapters(workId: string, window: McpPageWindow) {
    const library = await this.library.listLibrary();
    const work = library.works.find((candidate) => candidate.id === workId);
    if (!work) throw new Error("Work not found.");
    return {
      workId: work.id,
      ...pageWindow(work.chapters.length, window),
      chapters: work.chapters
        .slice(window.offset, window.offset + window.limit)
        .map((chapter) => ({
          id: chapter.id,
          title: chapter.title,
          status: chapter.status,
          pageCount: chapter.pageCount,
          updatedAt: chapter.updatedAt,
        })),
    };
  }

  async getChapter(chapterId: string, window: McpPageWindow) {
    const chapter = await this.library.openChapter(chapterId);
    return {
      id: chapter.id,
      workId: chapter.workId,
      title: chapter.title,
      status: chapter.status,
      updatedAt: chapter.updatedAt,
      ...pageWindow(chapter.pages.length, window),
      pages: chapter.pages
        .slice(window.offset, window.offset + window.limit)
        .map((page) => ({
          id: page.id,
          name: page.name,
          width: page.width,
          height: page.height,
          analysisStatus: page.analysisStatus,
          blockCount: page.blocks.length,
          updatedAt: page.updatedAt,
        })),
    };
  }
}

function pageWindow(total: number, window: McpPageWindow) {
  const next = window.offset + window.limit;
  return {
    total,
    offset: window.offset,
    limit: window.limit,
    nextOffset: next < total ? next : null,
  };
}
