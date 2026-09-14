import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import {
  pageContentResource,
  type AppActivityResource,
} from "../../shared/appActivityTypes";
import { AppActivityBusyError } from "../appActivityGate";
import { withLibraryMutation } from "../library/lock";
import type { ActiveJobStore } from "./activeJob";
import { reserveChapterTargets } from "./jobActivityResources";

export function reserveJobChapter(
  jobs: ActiveJobStore,
  jobId: string,
  chapter: ChapterSnapshot,
  pageIds: readonly string[],
  extraResources: AppActivityResource[] = [],
  queuePages = true,
): void {
  const job = jobs.get(jobId);
  if (!job?.resources) return;
  jobs.updateResources(jobId, [
    ...job.resources,
    ...reserveChapterTargets(chapter, pageIds),
    ...extraResources,
  ]);
  if (queuePages) jobs.pageHandoffs.reserve(jobId, chapter.id, pageIds);
}

export async function acquireJobPage(
  jobs: ActiveJobStore,
  jobId: string,
  chapterId: string,
  pageId: string,
  readChapter: (chapterId: string) => Promise<ChapterSnapshot>,
): Promise<MangaPage> {
  const job = jobs.get(jobId);
  if (!job) throw new Error("작업이 이미 종료되었습니다.");
  const signal = job.abortController.signal;
  await jobs.pageHandoffs.request(jobId, chapterId, pageId, signal);
  const resource = pageContentResource(chapterId, pageId);
  while (true) {
    await jobs.gate.waitForAvailable([resource], jobId, signal);
    signal.throwIfAborted();
    try {
      return await withLibraryMutation(async () => {
        signal.throwIfAborted();
        jobs.updateResources(jobId, [...(job.resources ?? []), resource]);
        const chapter = await readChapter(chapterId);
        signal.throwIfAborted();
        const page = chapter.pages.find((candidate) => candidate.id === pageId);
        if (!page) throw new Error("처리할 페이지가 삭제되었습니다.");
        jobs.pageHandoffs.set({
          jobId,
          chapterId,
          pageId,
          phase: "processing",
        });
        return page;
      });
    } catch (error) {
      if (!(error instanceof AppActivityBusyError)) throw error;
    }
  }
}

export function releaseJobPage(
  jobs: ActiveJobStore,
  jobId: string,
  chapterId: string,
  pageId: string,
  failed = false,
): void {
  const job = jobs.get(jobId);
  if (!job?.resources) return;
  const resource = pageContentResource(chapterId, pageId);
  jobs.updateResources(
    jobId,
    job.resources.filter(
      (item) => item.kind !== resource.kind || item.scope !== resource.scope,
    ),
  );
  jobs.pageHandoffs.set({
    jobId,
    chapterId,
    pageId,
    phase: failed ? "failed" : "completed",
  });
}
