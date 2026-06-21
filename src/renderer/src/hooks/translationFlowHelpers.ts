import type { LibraryIndex } from "../../../shared/types";

export type RunAnalysisOutcome = "completed" | "cancelled" | "failed" | "no-op";

export type ExecuteAnalysisJob = (
  runMode: "pending" | "all" | "single-page",
  pageId?: string,
  chapterId?: string,
) => Promise<RunAnalysisOutcome>;

/** Canonical chapter id order for a work (chapterOrder, with any strays appended). */
export function enumerateWorkChapterIds(
  library: LibraryIndex,
  workId: string,
): string[] {
  const work = library.works.find((item) => item.id === workId);
  if (!work) {
    return [];
  }
  const existing = new Set(work.chapters.map((chapter) => chapter.id));
  const ordered = work.chapterOrder.filter((id) => existing.has(id));
  const orderedSet = new Set(ordered);
  const strays = work.chapters
    .map((chapter) => chapter.id)
    .filter((id) => !orderedSet.has(id));
  return [...ordered, ...strays];
}

/**
 * Translate a list of chapters in order. Stops on cancellation; tolerates an
 * individual chapter failing. Returns "completed" if at least one chapter
 * finished, "failed" if all attempted chapters failed, "cancelled" on cancel.
 */
export async function runChaptersSequentially(
  execute: ExecuteAnalysisJob,
  chapterIds: string[],
  mode: "pending" | "all",
  pushStatus: (line: string) => void,
  passLabel: string,
): Promise<RunAnalysisOutcome> {
  let anyCompleted = false;
  let anyAttempted = false;
  for (let index = 0; index < chapterIds.length; index += 1) {
    if (chapterIds.length > 1) {
      pushStatus(`${passLabel} 번역 ${index + 1}/${chapterIds.length}화`);
    }
    const outcome = await execute(mode, undefined, chapterIds[index]);
    if (outcome === "cancelled") {
      return "cancelled";
    }
    if (outcome !== "no-op") {
      anyAttempted = true;
    }
    if (outcome === "completed") {
      anyCompleted = true;
    }
  }
  if (anyCompleted) {
    return "completed";
  }
  return anyAttempted ? "failed" : "no-op";
}
