import { randomUUID } from "node:crypto";
import type { MangaPage } from "../shared/libraryTypes";
import type { OpenRedactionWorkspace } from "../shared/imageRedactionWorkspace";
import { listLibrary, openChapter } from "./library/libraryReadFacade";
import { prepareImageRedactionPages } from "./imageRedactionPagePreparation";
import { readImageRedactionState } from "./imageRedactionStore";
import { openRedactionWorkspaceSession } from "./imageRedactionWorkspaceSessions";

export async function prepareRedactionWorkspace(
  request: Exclude<OpenRedactionWorkspace, { kind: "job" }>,
  root: string,
) {
  const pages = await resolvePages(request);
  const state = await readImageRedactionState(root);
  const prepared = await prepareImageRedactionPages(pages, state.pages);
  return openRedactionWorkspaceSession(prepared, randomUUID(), root);
}

async function resolvePages(
  request: Exclude<OpenRedactionWorkspace, { kind: "job" }>,
): Promise<MangaPage[]> {
  if (request.kind === "chapter") {
    const chapter = await openChapter(request.chapterId);
    const selected = request.pageIds ? new Set(request.pageIds) : null;
    if (
      selected &&
      (selected.size !== request.pageIds?.length ||
        [...selected].some(
          (id) => !chapter.pages.some((page) => page.id === id),
        ))
    )
      throw new Error("선택한 페이지 목록이 변경되었습니다.");
    return orderPages(
      chapter.pages.filter((page) => !selected || selected.has(page.id)),
      chapter.pageOrder,
    );
  }
  const work = (await listLibrary()).works.find(
    (item) => item.id === request.workId,
  );
  if (!work) throw new Error("선택한 작품을 찾을 수 없습니다.");
  const chapters = new Map(
    work.chapters.map((chapter) => [chapter.id, chapter]),
  );
  const ids = [...new Set([...work.chapterOrder, ...chapters.keys()])].filter(
    (id) => chapters.has(id),
  );
  const pages: MangaPage[] = [];
  for (const id of ids) {
    const chapter = await openChapter(id);
    if (chapter.workId !== work.id)
      throw new Error("작품의 화 목록이 변경되었습니다.");
    pages.push(
      ...orderPages(chapter.pages, chapter.pageOrder).map((page) => ({
        ...page,
        name: `${chapter.title} · ${page.name}`,
      })),
    );
    if (pages.length > 10000)
      throw new Error(
        "한 번에 10,000장까지 준비할 수 있습니다. 화를 나누어 선택해 주세요.",
      );
  }
  return pages;
}

function orderPages(pages: MangaPage[], order: string[]): MangaPage[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...pages].sort(
    (left, right) =>
      (positions.get(left.id) ?? order.length) -
      (positions.get(right.id) ?? order.length),
  );
}
