import type { JobEvent } from "../../shared/jobTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { tMain } from "./localization";

export type EmitPageImageExportEvent = (event: JobEvent) => void;

export function emitExportStarting(
  id: string,
  emit: EmitPageImageExportEvent,
  totalPages: number,
  chapterCount: number,
): void {
  emit({
    id,
    kind: "page-export",
    status: "starting",
    progressText: tMain("export.preparing"),
    phase: "finalizing",
    progressCurrent: 0,
    progressTotal: totalPages,
    pageTotal: totalPages,
    detail: tMain("export.selection", {
      chapters: chapterCount,
      pages: totalPages,
    }),
  });
}

export function emitExportPageProgress({
  id,
  emit,
  page,
  chapter,
  completedPages,
  totalPages,
  step,
}: {
  id: string;
  emit: EmitPageImageExportEvent;
  page: MangaPage;
  chapter: ChapterSnapshot;
  completedPages: number;
  totalPages: number;
  step: "running" | "done";
}): void {
  const current = step === "running" ? completedPages + 1 : completedPages;
  emit({
    id,
    kind: "page-export",
    status: "running",
    progressText: tMain(`export.page.${step}`, { current, total: totalPages }),
    phase: "finalizing",
    progressCurrent: completedPages,
    progressTotal: totalPages,
    pageIndex: current,
    pageTotal: totalPages,
    detail: `${chapter.title} · ${page.name}`,
  });
}

export function emitExportCompleted(
  id: string,
  emit: EmitPageImageExportEvent,
  totalPages: number,
  chapterCount: number,
): void {
  emit({
    id,
    kind: "page-export",
    status: "completed",
    progressText: tMain("export.completed"),
    phase: "done",
    progressCurrent: totalPages,
    progressTotal: totalPages,
    pageTotal: totalPages,
    detail: tMain("export.selection", {
      chapters: chapterCount,
      pages: totalPages,
    }),
  });
}
