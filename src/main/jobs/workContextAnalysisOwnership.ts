import type { AnalyzeWorkContextRequest } from "../../shared/workContextAnalysisTypes";
import {
  libraryStructureResource,
  type AppActivityResource,
} from "../../shared/appActivityTypes";
import type { listLibrary, openChapter } from "../library";
import { withLibraryRead } from "../library/lock";
import type { ActiveJobStore } from "./activeJob";

type AnalysisRepository = {
  listLibrary: typeof listLibrary;
  openChapter: typeof openChapter;
};

/** Reserve the input and destination together before inference can read either. */
export async function startWorkContextAnalysisWithOwnership(
  jobs: ActiveJobStore,
  id: string,
  abortController: AbortController,
  request: AnalyzeWorkContextRequest,
  repository: AnalysisRepository,
): Promise<void> {
  await withLibraryRead(async () => {
    const chapter = await repository.openChapter(request.chapterId);
    const library = await repository.listLibrary();
    const work = library.works.find((entry) => entry.id === chapter.workId);
    // The analyzer currently loads every chapter, even for chapter-only prompts.
    const chapterIds = [
      ...new Set([
        chapter.id,
        ...(work?.chapters.map((entry) => entry.id) ?? []),
      ]),
    ];
    const resources: AppActivityResource[] = [
      { kind: "model-runtime", scope: "*", access: "write" },
      { kind: "codex-auth", scope: "*", access: "read" },
      { kind: "work-context", scope: chapter.workId, access: "write" },
      libraryStructureResource("work", chapter.workId, "read"),
      ...chapterIds.flatMap((chapterId): AppActivityResource[] => [
        libraryStructureResource("chapter", chapterId, "read"),
        { kind: "page-content", scope: `${chapterId}/**`, access: "read" },
      ]),
    ];
    abortController.signal.throwIfAborted();
    jobs.start({ id, kind: "gemma-analysis", abortController, resources });
  });
}
